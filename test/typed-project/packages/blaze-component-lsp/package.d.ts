/**
 * Test stub mirroring blaze-component-lsp/types/index.d.ts
 * (`declare module` so augmentations merge).
 */
declare module "blaze-component-lsp" {
  export interface TemplateContextMap {}

  export type Template = keyof TemplateContextMap | (string & {});

  export type ContextDataFrom<T extends string> = T extends keyof TemplateContextMap
    ? TemplateContextMap[T]
    : Record<string, unknown>;

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
