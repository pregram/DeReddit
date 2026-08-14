import { describe, it, expect } from "vitest";
import { gradientMeshBackground } from "../gradientMesh";

describe("gradientMeshBackground", () => {
  it("is a pure function of its seed: same seed always yields the same gradient", () => {
    expect(gradientMeshBackground("technology")).toBe(gradientMeshBackground("technology"));
  });

  it("produces different gradients for different seeds", () => {
    expect(gradientMeshBackground("technology")).not.toBe(gradientMeshBackground("gaming"));
  });

  it("returns a CSS value built from 3 radial-gradients and 1 linear-gradient", () => {
    const css = gradientMeshBackground("art");
    expect(css.match(/radial-gradient/g)).toHaveLength(3);
    expect(css.match(/linear-gradient/g)).toHaveLength(1);
  });
});
