# Blaze Component LSP — Specification

## 1. Overview

**Blaze Component LSP** is a Language Server Protocol implementation that provides intelligent editor features for [Meteor](https://www.meteor.com/) projects using [Blaze](https://www.blazejs.org/) templates with the [blaze-component](./project-example/app/packages/blaze-component/) library.

The LSP operates exclusively on **HTML template files** containing Spacebars syntax. It does **not** replace the TypeScript/JavaScript language server — that continues to serve JS files. Instead, it bridges the gap between the two worlds: understanding which helpers, events, and typed context data are available inside each `<template>` block.

### Goals

- Provide autocompletion for helpers and context data fields inside `{{...}}` expressions
- Provide autocompletion for template names inside `{{> ...}}` partial inclusions
- Show type information and documentation on hover
- Navigate from template expressions to their JS definitions (go-to-definition)
- Report diagnostics for unknown helpers, unknown templates, and unregistered components
- Find all references to a helper or template across the project
- Work with both VS Code and Neovim

### Non-Goals (Phase 1)

- Replacing the TS/JS language server for `.js` files
- Providing features inside `.js` files (the TS server handles that)
- Runtime analysis or Meteor build integration
- Supporting non-BlazeComponent Blaze usage (plain `Template.x.helpers()`)

---

## 2. Definitions

### Template

An HTML `<template>` block defined in a `.html` file using Blaze syntax:

```html
<template name="toggleButton">
  <div class="toggle-button {{isChecked}}">
    {{#if text}}
      {{text}}{{{icon}}}
    {{/if}}
  </div>
</template>
```

A single `.html` file may contain multiple `<template>` blocks (though typically one).

### Spacebars Expression

A mustache-style expression inside a template. Types:

| Syntax | Type | Example |
|--------|------|---------|
| `{{expr}}` | Mustache (helper or data field) | `{{name}}`, `{{formatDate date}}` |
| `{{{expr}}}` | Raw/unescaped HTML | `{{{htmlContent}}}` |
| `{{> name}}` | Partial (template inclusion) | `{{> toggleButton}}` |
| `{{> name k=v}}` | Partial with hash args | `{{> tabs data=sections options=opts}}` |
| `{{#block}}...{{/block}}` | Block helper | `{{#if ready}}...{{/if}}` |
| `{{#each x in y}}` | Each-in iteration | `{{#each tab in data}}` |
| `{{else}}` | Else branch | inside `{{#if}}` or `{{#each}}` |
| `{{! text}}` | Comment | `{{! TODO: fix this}}` |
| `{{!-- text --}}` | Long comment | `{{!-- multi word comment --}}` |
| `{{> Template.dynamic template=t data=d}}` | Dynamic template | Runtime-resolved template |

### BlazeComponent

A JavaScript class extending `BlazeComponent` that is linked to a template. It defines helpers, events, lifecycle hooks, and typed context data.

### Component Registration

The act of linking a BlazeComponent class to a template. Three patterns exist:

**Pattern A — Explicit registration call:**
```js
BlazeComponent.register(Template.noteConfirm, ConfirmComponent);
```

**Pattern B — `@Component` decorator on the class:**
```js
@Component(Template.toggleButton)
export class toggleButton extends BlazeComponent { ... }
```

**Pattern C — `export @Component(...)` (export before decorator):**
```js
export @Component(Template.jp_cardsContainer)
class CardsContainer extends BlazeComponent { ... }
```

### Helper

A method on a BlazeComponent class that is exposed to the template as a Spacebars expression. Registered via:

**Pattern A — `static HelperMap()`:**
```js
static HelperMap() {
  return ["isChecked", "colors"];           // array form
  // or: return { myHelper: "methodName" }; // object form
}
```

**Pattern B — `@Helper` decorator:**
```js
@Helper
isChecked() {
  return this.checked.get() ? "checked" : "unchecked";
}
```

### Event Handler

A method on a BlazeComponent class bound to a DOM event + CSS selector. Registered via:

**Pattern A — `static EventMap()`:**
```js
static EventMap() {
  return { "click .confirm": "onConfirm" };
}
```

**Pattern B — `@Event` decorator:**
```js
@Event("click .dashboard-section-sort")
onSort(e) { ... }
```

### Context Data (ContextData)

The data object passed to a template when it is included. Typed via JSDoc:

```js
/**
 * @typedef {Object} ContextData
 * @prop {string}   html
 * @prop {string}   text
 * @prop {boolean}  checked
 * @prop {function(Event, TemplateInstance, boolean):void} onchange
 */

/** @extends BlazeComponent<ContextData> */
@Component(Template.toggleButton)
export class toggleButton extends BlazeComponent { ... }
```

Context data fields are accessed in templates identically to helpers: `{{text}}`, `{{checked}}`.

### Settings

Internal reactive state of a component, initialized in the constructor's second argument:

```js
constructor(templateInstance) {
  super(templateInstance, { color: "#3599cc" });
}
```

Typed as the second generic parameter: `BlazeComponent<ContextData, Settings>`.

---

## 3. Architecture

### 3.1 System Diagram

```
┌──────────────────────────────────────────────────┐
│                   Editor (VS Code / Neovim)       │
│                                                    │
│  ┌─────────────┐    ┌──────────────────────────┐  │
│  │ TS/JS Server │    │ Blaze Component LSP Client│  │
│  │ (built-in)   │    │ (extension / lspconfig)   │  │
│  └──────┬───────┘    └───────────┬──────────────┘  │
│         │ .js files              │ .html files      │
└─────────┼────────────────────────┼─────────────────┘
          │                        │ stdio
          │                ┌───────┴───────┐
          │                │  LSP Server    │
          │                │               │
          │                │ ┌───────────┐ │
          │                │ │  Project   │ │
          │                │ │  Index     │ │
          │                │ └─────┬─────┘ │
          │                │       │       │
          │                │ ┌─────┴─────┐ │
          │                │ │ Spacebars  │ │
          │                │ │ Parser     │ │
          │                │ ├───────────┤ │
          │                │ │ Component  │ │
          │                │ │ Parser     │ │
          │                │ └───────────┘ │
          │                └───────────────┘
```

### 3.2 Module Responsibilities

#### Spacebars Parser (`server/parsers/spacebarsParser.js`)

Tokenizes and parses the contents of `<template>` blocks. Produces an array of expression nodes, each with:
- `type`: `"MustacheExpression"`, `"RawExpression"`, `"PartialExpression"`, `"BlockExpression"`, `"Comment"`
- `path`: the identifier path (e.g., `"isChecked"`, `"Template.dynamic"`)
- `params`: positional arguments
- `hash`: key-value pairs (for `{{> partial key=value}}`)
- `loc`: `{ start: { line, column }, end: { line, column } }` — 0-based line and column within the file
- `children`: nested expressions for blocks
- `blockParams`: for `{{#each item in collection}}` — the bound variable names
- `inverse`: the `{{else}}` branch content

Does **not** parse standard HTML — only locates and parses `{{...}}` expressions within `<template>` blocks.

#### Component Parser (`server/parsers/componentParser.js`)

Uses the TypeScript compiler API to parse JavaScript files and extract:
- Component registrations (decorator or explicit call)
- Helper names and their method ranges
- Event selectors and their method ranges
- JSDoc `@typedef` for ContextData with field names and types
- `@extends BlazeComponent<ContextData>` type parameter extraction
- HTML import paths (`import "./template.html"`)
- Class inheritance chains

#### Template Indexer (`server/indexer/templateIndexer.js`)

Scans all `.html` files in the project, parses each `<template>` block, and maintains a `Map<templateName, TemplateInfo>`.

#### Component Indexer (`server/indexer/componentIndexer.js`)

Scans all `.js` files in the project, parses each file for BlazeComponent registrations, and maintains a `Map<templateName, ComponentInfo>`.

#### Project Index (`server/indexer/projectIndex.js`)

Cross-references template and component indexes. For a given template, resolves:
- Which component class is registered to it
- What helpers are available (from the component)
- What context data fields are expected (from JSDoc types)
- What sub-templates it includes

Also handles file watching and incremental updates.

#### Providers (`server/providers/*.js`)

Each provider implements one LSP capability:
- **CompletionProvider**: autocomplete suggestions
- **HoverProvider**: tooltip information
- **DefinitionProvider**: go-to-definition targets
- **DiagnosticProvider**: error/warning squiggles
- **ReferenceProvider**: find-all-references results

### 3.3 Data Model

```js
/** @typedef {Object} TemplateInfo
 *  @prop {string} name - Template name from <template name="...">
 *  @prop {string} filePath - Absolute path to the HTML file
 *  @prop {{ start: Position, end: Position }} range - Location of the <template> tag
 *  @prop {SpacebarsNode[]} expressions - Parsed spacebars expressions
 *  @prop {string[]} includedTemplates - Template names from {{> name}} partials
 */

/** @typedef {Object} ComponentInfo
 *  @prop {string} className - The class name
 *  @prop {string} filePath - Absolute path to the JS file
 *  @prop {string} templateName - Linked template name
 *  @prop {HelperInfo[]} helpers - Registered helpers
 *  @prop {EventInfo[]} events - Registered events
 *  @prop {ContextField[]} contextDataFields - Typed context data fields
 *  @prop {string|null} parentClass - Parent class name if extends something other than BlazeComponent
 *  @prop {string|null} htmlImportPath - The import "./template.html" path
 *  @prop {{ start: Position, end: Position }} classRange - Location of the class declaration
 */

/** @typedef {Object} HelperInfo
 *  @prop {string} name - Helper name (as used in templates)
 *  @prop {string} methodName - Method name on the class
 *  @prop {{ start: Position, end: Position }} range - Location of the method
 *  @prop {string} [returnType] - Return type from JSDoc or inference
 *  @prop {string} [documentation] - JSDoc comment text
 */

/** @typedef {Object} EventInfo
 *  @prop {string} selector - Event selector (e.g., "click .confirm")
 *  @prop {string} methodName - Method name on the class
 *  @prop {{ start: Position, end: Position }} range - Location of the method
 */

/** @typedef {Object} ContextField
 *  @prop {string} name - Field name
 *  @prop {string} type - Type string from JSDoc
 *  @prop {string} [description] - Description from JSDoc @prop
 *  @prop {{ start: Position, end: Position }} range - Location of the @prop declaration
 */
```

---

## 4. Feature Specification

### 4.1 Completion

**Trigger**: typing inside `{{` or `{{>` in an HTML template file.

| Cursor Position | Suggestions |
|----------------|-------------|
| `{{�cursor}}` | All helpers + context data fields for this template's component |
| `{{{�cursor}}}` | Same as above (raw expression) |
| `{{> �cursor}}` | All known template names |
| `{{> knownTemplate �cursor}}` | Context data fields expected by the target template |
| `{{#each item in �cursor}}` | Helpers + context data fields |
| `{{#if �cursor}}` | Helpers + context data fields |

Completion items include:
- `label`: the helper/field/template name
- `kind`: `CompletionItemKind.Function` for helpers, `CompletionItemKind.Field` for data fields, `CompletionItemKind.Module` for templates
- `detail`: return type or field type
- `documentation`: JSDoc description

### 4.2 Hover

**Trigger**: hovering over an identifier inside `{{...}}`.

| Hovered Element | Displayed Info |
|----------------|----------------|
| Helper name (`{{isChecked}}`) | Method signature, return type, JSDoc, source file:line |
| Data field (`{{text}}`) | Field type from ContextData typedef, description |
| Template name (`{{> tabs}}`) | Template file path, component class name |
| Hash key (`{{> toggle checked=...}}`) | Expected type of that field on the target template |
| Block helper (`{{#each}}`) | Built-in block helper documentation |

### 4.3 Go-to-Definition

| Source | Target |
|--------|--------|
| `{{helperName}}` | Method definition in the component JS file |
| `{{> templateName}}` | `<template name="...">` in the HTML file |
| `{{contextField}}` | `@prop {type} fieldName` in the JSDoc typedef |

### 4.4 Diagnostics

| Condition | Severity | Message |
|-----------|----------|---------|
| `{{unknown}}` where no helper or context field matches | Warning | `Unknown helper or data field "unknown" in template "templateName"` |
| `{{> missing}}` where no template exists | Error | `Template "missing" is not defined` |
| Template has no component registered | Info | `Template "name" has no BlazeComponent registered` |

Diagnostics are computed on file open and on change (debounced).

### 4.5 Find References

| Query | Results |
|-------|---------|
| Helper name | All `{{helperName}}` usages across HTML files |
| Template name | All `{{> templateName}}` inclusions across HTML files |

---

## 5. Spacebars Parser — Detailed Requirements

### 5.1 Input

The full text content of an HTML file. The parser must:
1. Locate all `<template name="...">` blocks and their byte/line ranges
2. Within each template block, locate and parse all `{{...}}` expressions
3. Track accurate source positions (0-based line and column) relative to the file

### 5.2 Output

For each template block, an array of `SpacebarsNode` objects:

```js
/** @typedef {Object} SpacebarsNode
 *  @prop {"MustacheExpression"|"RawExpression"|"PartialExpression"|"BlockExpression"|"Comment"} type
 *  @prop {string} path - Identifier path ("helperName", "Template.dynamic")
 *  @prop {SpacebarsParam[]} params - Positional arguments
 *  @prop {Object<string, SpacebarsParam>} hash - Named arguments (key=value)
 *  @prop {{ start: {line: number, column: number}, end: {line: number, column: number} }} loc
 *  @prop {SpacebarsNode[]} [children] - Block body expressions
 *  @prop {SpacebarsNode[]} [inverse] - {{else}} branch expressions
 *  @prop {string[]} [blockParams] - For {{#each x in y}}: ["x"]
 */

/** @typedef {Object} SpacebarsParam
 *  @prop {"PathExpression"|"StringLiteral"|"NumberLiteral"|"BooleanLiteral"|"SubExpression"} type
 *  @prop {string} value - The raw value
 *  @prop {{ start: {line: number, column: number}, end: {line: number, column: number} }} loc
 */
```

### 5.3 Examples

Input:
```html
<template name="toggleButton">
  <div class="{{isChecked}} {{#if isDisabled}}disabled{{/if}}">
    {{> icon name="check"}}
    {{text}}
  </div>
</template>
```

Parsed template name: `"toggleButton"` at line 0.

Expressions extracted:
1. `MustacheExpression { path: "isChecked", loc: {start: {line: 1, column: 15}, ...} }`
2. `BlockExpression { path: "if", params: [{type: "PathExpression", value: "isDisabled"}], children: [...], loc: ... }`
3. `PartialExpression { path: "icon", hash: { name: {type: "StringLiteral", value: "check"} }, loc: ... }`
4. `MustacheExpression { path: "text", loc: ... }`

---

## 6. Component Parser — Detailed Requirements

### 6.1 Input

The text content of a JavaScript file.

### 6.2 Extraction Rules

**Registration detection** — look for any of:
- `BlazeComponent.register(Template.X, ClassName)` — extract `X` as template name
- `@Component(Template.X)` decorator on a class — extract `X` as template name
- Both patterns may coexist in the same file (decorator + explicit call)

**Helper detection** — look for:
- `static HelperMap()` returning an array literal `["name1", "name2"]` — each string is a helper name mapping to a method of the same name
- `static HelperMap()` returning an object literal `{ helperName: "methodName" }` — keys are helper names, values are method names
- `@Helper` decorator above a method — method name is the helper name

**Event detection** — look for:
- `static EventMap()` returning `{ "event selector": "methodName" }`
- `@Event("event selector")` decorator above a method

**Context data extraction** — look for:
- `@typedef {Object} ContextData` (or any name) with `@prop` tags, referenced by `@extends BlazeComponent<TypeName>`
- The `@extends` JSDoc tag on the class indicating which typedef is the ContextData
- Extract each `@prop {type} name - description`

**HTML import detection** — look for:
- `import "./something.html"` or `import "/path/to/something.html"` — string literal imports ending in `.html`

### 6.3 Output

A `ComponentInfo` object (see Data Model in section 3.3).

---

## 7. Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Language | JavaScript (ES2022) with JSDoc type annotations | — |
| Type checking | TypeScript compiler API (programmatic) | ^5.x |
| LSP server | `vscode-languageserver` | ^9.x |
| LSP client (VS Code) | `vscode-languageclient` | ^9.x |
| LSP client (Neovim) | Built-in `vim.lsp` + lspconfig | — |
| Testing | Node.js `node:test` + `node:assert` | Node 20+ |
| Transport | stdio | — |

---

## 8. Editor Integration

### 8.1 VS Code Extension

- **Activation**: `onLanguage:html` with a check for `.meteor` directory in the workspace
- **Language ID**: `html` (piggybacks on the existing HTML language — we add features, not replace)
- **Server**: spawned as a child process via stdio
- **Capabilities registered**: completion, hover, definition, diagnostics, references
- **Does NOT interfere** with the built-in HTML language features or the TS/JS server

### 8.2 Neovim

Configuration via `lspconfig`:

```lua
local lspconfig = require("lspconfig")
local configs = require("lspconfig.configs")

configs.blaze_component_lsp = {
  default_config = {
    cmd = { "node", "/path/to/blaze-component-lsp/server/index.js", "--stdio" },
    filetypes = { "html" },
    root_dir = lspconfig.util.root_pattern(".meteor"),
    settings = {},
  },
}

lspconfig.blaze_component_lsp.setup({})
```

---

## 9. Project Configuration

The LSP discovers the project root by finding the nearest ancestor directory containing a `.meteor` folder. It then:

1. Scans all `.html` files for `<template>` definitions
2. Scans all `.js` files for BlazeComponent registrations
3. Excludes `node_modules`, `.meteor/local`, and directories listed in `.gitignore`
4. Watches for file changes and incrementally updates the index

No configuration file is required. Future versions may support a `.blazelsprc.json` for customizing scan paths, excludes, and other options.

---

## 10. Glossary

| Term | Definition |
|------|-----------|
| **Spacebars** | Meteor's template language, a variant of Handlebars |
| **BlazeComponent** | The custom library mapping ES6 classes to Blaze templates |
| **Helper** | A function exposed to the template that can be called in `{{...}}` expressions |
| **Context Data** | The data object passed to a template, accessible as `this` in helpers |
| **Settings** | Internal reactive state of a component (via `ReactiveDict`) |
| **Partial** | A template inclusion via `{{> templateName}}` |
| **Block Helper** | A helper that wraps content: `{{#if}}...{{/if}}`, `{{#each}}...{{/each}}` |
| **Registration** | Linking a BlazeComponent class to a Blaze template |
