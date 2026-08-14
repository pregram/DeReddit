// src/pages/ForumDiscoveryPage.tsx - Screen 3: search by name (fuzzy on the
// backend), filter by category, sort by engagement score / member count /
// creation date. Uses "Load more" rather than page-number pagination since
// the backend only reports the current page's row count, not a total.
// activeSort is passed down to ForumCard so the popularity score is only
// shown when it's the metric actually being sorted on.
//
// Tag filtering (this revision): multiple tag pills, ANDed together (a
// forum must carry every selected chip) - typing a tag and pressing Enter
// (or picking a suggestion) locks it in as a removable Pill, sent to the
// backend as the comma-joined `tags` param (exact, case-insensitive
// per-tag match, unlike the legacy `tag` substring/OR param).
//
// Selected tags are DERIVED from ?tags= (useMemo), not mirrored into their
// own state synced back and forth via a pair of effects - that dueling-
// effects shape (URL -> state, state -> URL) is exactly what produces
// "Maximum update depth exceeded" once useSearchParams's ever-fresh
// `searchParams` reference is in the mix. addTag/removeTag write straight
// to the URL; there's only one source of truth. A lone legacy ?tag= (from
// an older link, e.g. ForumCard/ForumHubPage tag badges) is folded in as a
// single starting chip so old links keep working.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDebouncedValue } from "@mantine/hooks";
import { Stack, Title, TextInput, Select, Autocomplete, Group, Pill, SimpleGrid, Text, Loader, Alert } from "@mantine/core";
import { IconSearch, IconTag } from "@tabler/icons-react";
import { api, type ForumSummary } from "../lib/api";
import { ForumCard } from "../components/ForumCard";
import { useInfiniteScroll } from "../lib/useInfiniteScroll";

const CATEGORIES = ["Technology", "Gaming", "Science", "Art", "Music", "Sports", "Finance", "General"];
const SORTS = [
  { value: "score", label: "Engagement Score" },
  { value: "members", label: "Member Count" },
  { value: "newest", label: "Creation Date" },
];
const PAGE_SIZE = 12;

function parseTagsParam(searchParams: URLSearchParams): string[] {
  const tagsParam = searchParams.get("tags");
  if (tagsParam) return tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
  // Legacy single-tag link (?tag=) - fold into a one-entry chip list.
  const legacyTag = searchParams.get("tag");
  return legacyTag ? [legacyTag] : [];
}

export function ForumDiscoveryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTags = useMemo(() => parseTagsParam(searchParams), [searchParams]);
  const tagsKey = selectedTags.join(",");
  const [tagInput, setTagInput] = useState("");
  const [debouncedTagInput] = useDebouncedValue(tagInput, 300);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  // Search box: local state for instant keystroke feedback, debounced before
  // it becomes the URL/query value - writing every keystroke straight to the
  // URL would spam history and re-trigger the fetch effect on every letter.
  // category/sort have no such concern (single-click Select changes) so they
  // read straight from searchParams, same as `tags` above - one source of
  // truth, no URL<->state dueling effects (see file header comment).
  const [searchInput, setSearchInput] = useState(() => searchParams.get("search") ?? "");
  const [debouncedSearch] = useDebouncedValue(searchInput, 300);
  const category = searchParams.get("category");
  const sort = searchParams.get("sort") ?? "score";
  const [forums, setForums] = useState<ForumSummary[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Suggestions reflect every forum's tags, not just the ones loaded on
  // this page - keyed off the live (debounced) input, not the locked chips.
  useEffect(() => {
    let cancelled = false;
    api.getForumTags(debouncedTagInput)
      .then((data) => { if (!cancelled) setTagSuggestions(data.tags); })
      .catch(() => { if (!cancelled) setTagSuggestions([]); });
    return () => { cancelled = true; };
  }, [debouncedTagInput]);

  // One-way write: debounced typed search -> URL (replace, so typing doesn't
  // spam browser history). Never reads back from the URL after mount, which
  // is what keeps this from becoming the dueling-effects shape described
  // above - `debouncedSearch` (local state) stays the single source the
  // query effect below reads from either way.
  useEffect(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (debouncedSearch) next.set("search", debouncedSearch);
      else next.delete("search");
      return next;
    }, { replace: true });
  }, [debouncedSearch, setSearchParams]);

  // Bumped on every filter change so a `loadMore` response from a
  // superseded filter (still in flight when the user changes search/
  // category/tags/sort) can detect it's stale and get dropped instead of
  // being appended onto the new filter's results / desyncing `page`.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const myRequestId = ++requestIdRef.current;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    api
      .getForums({ search: debouncedSearch || undefined, category: category ?? undefined, tags: tagsKey || undefined, sort, page: 1, limit: PAGE_SIZE })
      .then((data) => {
        if (requestIdRef.current !== myRequestId) return;
        setForums(data.forums);
        setPage(1);
        setHasMore(data.forums.length === PAGE_SIZE);
      })
      .catch((err) => { if (requestIdRef.current === myRequestId) setError(err instanceof Error ? err.message : "Failed to load forums"); })
      .finally(() => { if (requestIdRef.current === myRequestId) setLoading(false); });
  }, [debouncedSearch, category, tagsKey, sort]);

  const loadMore = () => {
    const myRequestId = requestIdRef.current;
    const nextPage = page + 1;
    setLoading(true);
    api
      .getForums({ search: debouncedSearch || undefined, category: category ?? undefined, tags: tagsKey || undefined, sort, page: nextPage, limit: PAGE_SIZE })
      .then((data) => {
        if (requestIdRef.current !== myRequestId) return;
        setForums((prev) => [...prev, ...data.forums]);
        setPage(nextPage);
        setHasMore(data.forums.length === PAGE_SIZE);
      })
      .catch((err) => { if (requestIdRef.current === myRequestId) setError(err instanceof Error ? err.message : "Failed to load forums"); })
      .finally(() => { if (requestIdRef.current === myRequestId) setLoading(false); });
  };

  const sentinelRef = useInfiniteScroll(loadMore, hasMore && !loading);

  const addTag = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setTagInput("");
    if (selectedTags.includes(value)) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("tag");
      next.set("tags", [...selectedTags, value].join(","));
      return next;
    }, { replace: true });
  };

  const removeTag = (tag: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const remaining = selectedTags.filter((t) => t !== tag);
      next.delete("tag");
      if (remaining.length) next.set("tags", remaining.join(","));
      else next.delete("tags");
      return next;
    }, { replace: true });
  };

  const setCategory = (value: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set("category", value);
      else next.delete("category");
      return next;
    }, { replace: true });
  };

  const setSort = (value: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("sort", value ?? "score");
      return next;
    }, { replace: true });
  };

  // Only fed to the manual Enter handler below; when suggestions exist,
  // Enter is handled entirely by the Autocomplete's own onOptionSubmit
  // (selecting the highlighted match) - letting the manual handler also
  // fire for that same keypress is what previously committed both the raw
  // typed text and the selected suggestion as separate chips.
  const visibleSuggestions = tagSuggestions.filter((t) => !selectedTags.includes(t));

  return (
    <Stack gap="lg" py="md">
      <Title order={1}>Discover Communities</Title>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <TextInput
          placeholder="Search by forum name..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.currentTarget.value)}
          leftSection={<IconSearch size={16} stroke={1.75} aria-hidden="true" />}
        />
        <Select placeholder="All categories" data={CATEGORIES} value={category} onChange={setCategory} clearable />
        <Select data={SORTS} value={sort} onChange={setSort} allowDeselect={false} />
      </SimpleGrid>

      <Stack gap="xs">
        <Autocomplete
          placeholder="Type a tag and press Enter..."
          value={tagInput}
          onChange={setTagInput}
          data={visibleSuggestions}
          onOptionSubmit={addTag}
          onKeyDown={(e) => {
            if (e.key === "Enter" && visibleSuggestions.length === 0 && tagInput.trim()) {
              e.preventDefault();
              addTag(tagInput);
            }
          }}
          clearable
          maw={320}
          leftSection={<IconTag size={16} stroke={1.75} aria-hidden="true" />}
        />
        {selectedTags.length > 0 && (
          <Pill.Group>
            {selectedTags.map((tag) => (
              <Pill key={tag} withRemoveButton onRemove={() => removeTag(tag)}>{tag}</Pill>
            ))}
          </Pill.Group>
        )}
      </Stack>

      {error && <Alert color="red" role="alert">{error}</Alert>}
      {!loading && forums.length === 0 && !error && <Text c="dimmed" size="sm">No forums matched your search.</Text>}

      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {forums.map((forum) => <ForumCard key={forum.forum_key} forum={forum} activeSort={sort} />)}
      </SimpleGrid>

      {loading && <Group justify="center" py="xl"><Loader size="sm" /></Group>}
      {hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
    </Stack>
  );
}
