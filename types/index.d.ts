/**
 * Placeholder types for `import("blaze-component-lsp")`.
 *
 * Per Meteor app / package, blaze-component-lsp generates
 * `.blaze-component-lsp/templates.d.ts` (and helpers.d.ts) that *augment*
 * `TemplateContextMap` / helper maps for that TypeScript program only.
 *
 * Must use `declare module` (not bare top-level exports) so path-mapped
 * stubs merge with those augmentations. Otherwise
 * `import("blaze-component-lsp").Template` is missing and JSDoc `@template`
 * constraints collapse to `any`.
 *
 * Install as a monorepo root devDependency. Do not include other programs'
 * `.blaze-component-lsp` folders in the same tsconfig or the maps merge.
 */
declare module "blaze-component-lsp" {
  export interface TemplateContextMap {}

  /**
   * Known template names when a registry is loaded in this program;
   * otherwise any string (so shared packages still typecheck at the root).
   */
  export type Template = keyof TemplateContextMap | (string & {});

  /** ContextData for a template name (loose object if not in the map yet). */
  export type ContextDataFrom<T extends string> = T extends keyof TemplateContextMap
    ? TemplateContextMap[T]
    : Record<string, unknown>;

  /** Alias of ContextDataFrom for JSDoc ergonomics. */
  export type ContextData<T extends string> = ContextDataFrom<T>;

  export interface GlobalHelpers {}

  export interface TemplateHelpersMap {}

  export type GlobalHelper = keyof GlobalHelpers;

  export type HelpersOf<T extends keyof TemplateHelpersMap> = TemplateHelpersMap[T];

  export type TemplateEntry<TExtras = {}> = {
    [K in keyof TemplateContextMap]: TExtras & {
      template: K;
      data: ContextDataFrom<K & string>;
    };
  }[keyof TemplateContextMap];
}
