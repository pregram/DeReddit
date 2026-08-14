import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ForumIcon } from "../ForumIcon";

describe("ForumIcon", () => {
  it("renders a jazzicon deterministically seeded from keccak256(name)", () => {
    const { container: containerA } = render(<ForumIcon name="technology" />);
    const { container: containerB } = render(<ForumIcon name="technology" />);
    expect(containerA.querySelector("div[aria-hidden] > *")).not.toBeNull();
    expect(containerA.innerHTML).toBe(containerB.innerHTML);
  });

  it("renders a different icon for a different forum name", () => {
    const { container: containerA } = render(<ForumIcon name="technology" />);
    const { container: containerB } = render(<ForumIcon name="gaming" />);
    expect(containerA.innerHTML).not.toBe(containerB.innerHTML);
  });

  it("sizes the wrapping div to the requested size", () => {
    const { container } = render(<ForumIcon name="technology" size={48} />);
    const wrapper = container.querySelector("div[aria-hidden]") as HTMLDivElement;
    expect(wrapper.style.width).toBe("48px");
    expect(wrapper.style.height).toBe("48px");
  });
});
