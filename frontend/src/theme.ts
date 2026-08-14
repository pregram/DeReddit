// src/theme.ts - Central Mantine theme. This is the actual token source for
// the app. Semantic states (locked/flagged/pending/confirmed) reuse
// Mantine's built-in color names directly on components (color="gray"|
// "orange"|"blue"|"green") rather than a parallel custom-token system.
//
// Accent ramp is derived from the shipped favicon brand mark
// (frontend/public/favicon.svg, ~#863bff) - shade 5 below reproduces that
// hue almost exactly (H~263deg). Dark neutrals are a purple-tinted low-
// saturation ramp (same hue, ~12% saturation) rather than Mantine's default
// gray-based `dark` palette, so dark mode reads as the same brand world
// instead of a mechanical inversion.

import {
  Badge,
  Button,
  Card,
  createTheme,
  Menu,
  Modal,
  NumberInput,
  Paper,
  Pill,
  Popover,
  Select,
  Tabs,
  Textarea,
  TextInput,
  Autocomplete,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from "@mantine/core";

const accent: MantineColorsTuple = [
  "#F6F0FF",
  "#E9DBFF",
  "#D0B3FF",
  "#B080FF",
  "#9A5CFF",
  "#873DFF",
  "#6E14FF",
  "#5A00EB",
  "#4A00C2",
  "#3B0099",
];

const dark: MantineColorsTuple = [
  "#C5C0CE",
  "#A9A1B5",
  "#9187A1",
  "#5E556D",
  "#393442",
  "#2D2833",
  "#25222B",
  "#19161D",
  "#131115",
  "#0F0D11",
];

const fontFamily = "'Inter Variable', -apple-system, BlinkMacSystemFont, sans-serif";

// Unselected/not-flagged vote and flag icon colors in dark mode only - the
// selected/active state keeps Mantine's default filled green/red/orange, and
// light mode is untouched (call sites only apply these when colorScheme ===
// "dark").
export const darkModeInactiveIconColors = {
  upvote: "rgb(180, 255, 180)",
  downvote: "rgb(255, 180, 180)",
  flag: "rgb(255, 220, 180)",
} as const;

export const theme = createTheme({
  primaryColor: "accent",
  primaryShade: { light: 6, dark: 5 },
  colors: { accent, dark },
  defaultRadius: "md",

  fontFamily,
  fontFamilyMonospace:
    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",

  headings: {
    fontFamily,
    fontWeight: "700",
    sizes: {
      h1: { fontSize: "2rem", lineHeight: "1.2" },
      h2: { fontSize: "1.75rem", lineHeight: "1.25" },
      h3: { fontSize: "1.5rem", lineHeight: "1.3" },
      h4: { fontSize: "1.25rem", lineHeight: "1.35" },
      h5: { fontSize: "1.125rem", lineHeight: "1.4" },
      h6: { fontSize: "1rem", lineHeight: "1.4" },
    },
  },

  // Brand-tinted near-black shadows (not pure black) with soft multi-layer
  // stacking for genuine elevation in light mode. Dark mode collapses these
  // to hairline borders via cssVariablesResolver below - large shadows don't
  // read against near-black surfaces.
  shadows: {
    xs: "0 1px 2px rgba(43, 20, 82, 0.06)",
    sm: "0 1px 3px rgba(43, 20, 82, 0.08), 0 4px 8px rgba(43, 20, 82, 0.06)",
    md: "0 2px 6px rgba(43, 20, 82, 0.08), 0 8px 20px rgba(43, 20, 82, 0.08)",
    lg: "0 4px 12px rgba(43, 20, 82, 0.10), 0 16px 32px rgba(43, 20, 82, 0.10)",
    xl: "0 8px 20px rgba(43, 20, 82, 0.12), 0 24px 48px rgba(43, 20, 82, 0.12)",
  },

  components: {
    Card: Card.extend({
      defaultProps: { withBorder: true },
      styles: {
        root: {
          backgroundColor: "var(--app-surface-1)",
          borderColor: "var(--app-border)",
        },
      },
    }),
    Paper: Paper.extend({
      styles: {
        root: {
          borderColor: "var(--app-border)",
        },
      },
    }),
    Button: Button.extend({
      styles: {
        root: {
          fontWeight: 600,
          transition: "background-color 120ms ease, transform 120ms ease, box-shadow 120ms ease",
        },
      },
    }),
    ActionIcon: {
      styles: {
        root: {
          transition: "background-color 120ms ease, color 120ms ease",
        },
      },
      vars: () => ({
        root: {
          "--ai-hover": "var(--mantine-color-accent-light-hover)",
        },
      }),
    },
    Badge: Badge.extend({
      defaultProps: { radius: "sm" },
    }),
    Pill: Pill.extend({
      defaultProps: { radius: "sm" },
    }),
    Modal: Modal.extend({
      defaultProps: {
        overlayProps: { backgroundOpacity: 0.55, blur: 4 },
        radius: "md",
      },
    }),
    TextInput: TextInput.extend({
      styles: {
        input: {
          borderColor: "var(--app-border)",
        },
      },
    }),
    Select: Select.extend({
      styles: {
        input: {
          borderColor: "var(--app-border)",
        },
      },
    }),
    NumberInput: NumberInput.extend({
      styles: {
        input: {
          borderColor: "var(--app-border)",
        },
      },
    }),
    Textarea: Textarea.extend({
      styles: {
        input: {
          borderColor: "var(--app-border)",
        },
      },
    }),
    Autocomplete: Autocomplete.extend({
      styles: {
        input: {
          borderColor: "var(--app-border)",
        },
      },
    }),
    Tabs: Tabs.extend({
      styles: {
        tab: {
          borderRadius: "var(--mantine-radius-sm)",
        },
      },
    }),
    Popover: Popover.extend({
      defaultProps: { radius: "md", shadow: "md" },
    }),
    Menu: Menu.extend({
      defaultProps: { radius: "md", shadow: "md" },
    }),
  },
});

// Mantine's default light-mode `dimmed` token is gray.6 (#868e96 on white),
// which computes to ~3.3:1 contrast - below the 4.5:1 WCAG AA minimum for
// normal text. It's used everywhere in this app (author bylines, timestamps,
// metadata), mostly at size="xs". Dark mode's default dimmed token already
// clears AA comfortably, so only the light variant needs overriding.
//
// Also adds elevation surface tokens (--app-surface-1/2, --app-border) per
// color scheme, and collapses shadows to hairline borders in dark mode,
// where large soft shadows don't read against near-black backgrounds.
export const cssVariablesResolver: CSSVariablesResolver = (t) => ({
  variables: {
    // Mantine's default xs/sm Badge font sizes (9px/10px) render below a
    // legible floor for functional text (post-type, flag-count, karma
    // badges throughout the app all use these sizes) - bumped to match the
    // 11px "md" size instead, with a touch more height/padding so the
    // larger glyphs don't feel cramped. lg/xl are already fine (13px/16px).
    "--badge-fz-xs": "11px",
    "--badge-height-xs": "18px",
    "--badge-padding-x-xs": "8px",
    "--badge-fz-sm": "11px",
    "--badge-height-sm": "19px",
  },
  light: {
    "--mantine-color-dimmed": t.colors.gray[7],
    "--app-surface-1": t.white,
    "--app-surface-2": t.colors.gray[0],
    "--app-border": t.colors.gray[3],
  },
  dark: {
    "--app-surface-1": t.colors.dark[7],
    "--app-surface-2": t.colors.dark[6],
    "--app-border": t.colors.dark[4],
    "--mantine-shadow-xs": "0 0 0 1px var(--app-border)",
    "--mantine-shadow-sm": "0 0 0 1px var(--app-border)",
    "--mantine-shadow-md": "0 0 0 1px var(--app-border)",
    "--mantine-shadow-lg": "0 0 0 1px var(--app-border)",
    "--mantine-shadow-xl": "0 0 0 1px var(--app-border)",
  },
});
