// Single-file components and stylesheets are Vite's to resolve, not tsc's.
//
// The components are deliberately thin - all the logic that can be wrong lives in the .ts files
// beside them, where node:test can reach it - so typing them as generic components buys accuracy
// that would cost a `vue-tsc` dependency to collect.

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module "*.css";
