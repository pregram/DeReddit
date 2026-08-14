import { Link } from "react-router-dom";
import { Group, Text } from "@mantine/core";
import { UserAvatar } from "./UserAvatar";
import { truncateAddress } from "../lib/format";

interface AuthorLinkProps {
  wallet: string;
  username?: string | null;
  profileCid?: string | null;
  size?: number;
  showIdenticon?: boolean;
}

export function AuthorLink({ wallet, username, profileCid, size = 18, showIdenticon = true }: AuthorLinkProps) {
  return (
    <Link to={`/u/${wallet}`} style={{ textDecoration: "none", color: "inherit" }}>
      <Group gap="xs" wrap="nowrap">
        {showIdenticon && <UserAvatar wallet={wallet} profileCid={profileCid} size={size} />}
        <Text size="xs" c="dimmed">u/{username ?? truncateAddress(wallet)}</Text>
      </Group>
    </Link>
  );
}
