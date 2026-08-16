// Single-file components and stylesheets are Vite's to resolve, not tsc's. The components are thin
// by design, so typing them generically costs accuracy a `vue-tsc` dependency would have to buy.

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module "*.css";
