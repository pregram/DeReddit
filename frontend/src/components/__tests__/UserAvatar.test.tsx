import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { UserAvatar } from "../UserAvatar";
import { bytes32ToIpfsCid, ZERO_BYTES32 } from "../../lib/hash";
import { ipfsGatewayUrl } from "../../lib/ipfs";

const WALLET = "0x1234567890123456789012345678901234567890";

function renderAvatar(props: Partial<React.ComponentProps<typeof UserAvatar>>) {
  return render(
    <MantineProvider>
      <UserAvatar wallet={WALLET} {...props} />
    </MantineProvider>
  );
}

describe("UserAvatar", () => {
  it("falls back to Identicon when profileCid is missing", () => {
    const { container } = renderAvatar({ profileCid: null });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("div[aria-hidden]")).not.toBeNull();
  });

  it("falls back to Identicon when profileCid is the zero sentinel", () => {
    const { container } = renderAvatar({ profileCid: ZERO_BYTES32 });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("div[aria-hidden]")).not.toBeNull();
  });

  it("renders an <img> pointed at the IPFS gateway URL when a real profileCid is set", () => {
    const profileCid = "0x" + "ab".repeat(32);
    const { container } = renderAvatar({ profileCid });
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(ipfsGatewayUrl(bytes32ToIpfsCid(profileCid)));
  });

  it("falls back to Identicon after the avatar image fails to load", () => {
    const profileCid = "0x" + "cd".repeat(32);
    const { container } = renderAvatar({ profileCid });
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("div[aria-hidden]")).not.toBeNull();
  });
});
