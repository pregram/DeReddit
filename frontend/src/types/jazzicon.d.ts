// src/types/jazzicon.d.ts - @metamask/jazzicon ships plain JS with no
// TypeScript definitions and has no @types package on DefinitelyTyped, so
// importing it under this project's strict tsconfig would otherwise fail
// with "could not find a declaration file". This ambient module declaration
// unblocks the import used in src/components/Identicon.tsx.
//
// The real function signature is jazzicon(diameter: number, seed: number),
// returning a DOM element (an SVG-in-a-div wrapper) ready to append.

declare module "@metamask/jazzicon" {
  function jazzicon(diameter: number, seed: number): HTMLElement;
  export default jazzicon;
}