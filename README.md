# Blaze Component LSP

Language server and CLI type-checker for [Meteor](https://www.meteor.com/) projects using [Blaze](https://www.blazejs.org/), [Spacebars](https://www.blazejs.org/api/spacebars), and [BlazeComponent](https://github.com/peerlibrary/meteor-blaze-components).

Provides editor intelligence for HTML template files — aware of your templates, helpers, context data types, and global helpers.

## Features

- **Completions** — helpers, context data fields, template names (`{{>`), block helpers (`{{#`), and hash arguments
- **Hover** — type information and documentation for helpers, fields, and templates
- **Go to Definition** — jump from a helper/template usage in HTML to its JS definition
- **Find References** — find all usages of a helper or template across HTML files
- **Diagnostics** — unknown helpers, missing templates, type mismatches, unknown context data fields
- **CLI type-checker** — run `blaze-check` in CI or npm scripts like ESLint
- **Syntax highlighting** — Spacebars syntax highlighting for VS Code and Neovim

## What it understands

- Templates defined in `.html` files
- `@Component(Template.name)` decorator registration
- `BlazeComponent.register(Template.name, Class)` explicit registration
- `static HelperMap()` and `@Helper` decorator for helpers
- `static EventMap()` and `@Event` decorator for events
- `@typedef ContextData` JSDoc for typed context data
- `@extends {BlazeComponent<Type>}` for simple context types
- `Blaze.registerHelper()` and `Template.registerHelper()` for global helpers
- Block templates (templates using `Template.contentBlock` / `Template.elseBlock`)
- Monorepo support — scoped per `.meteor` project root

## Setup

### Prerequisites

```bash
git clone <repo-url> ~/Projects/blaze-component-lsp
cd ~/Projects/blaze-component-lsp
npm install
```

### VS Code

1. Install the extension dependencies:

```bash
cd ~/Projects/blaze-component-lsp/client/vscode
npm install
```

2. Symlink the extension into your VS Code extensions directory:

```bash
ln -s ~/Projects/blaze-component-lsp/client/vscode ~/.vscode/extensions/blaze-component-lsp
```

3. Reload VS Code. The extension activates automatically when it detects a `.meteor` directory in your workspace.

**Settings** (optional, in VS Code `settings.json`):

```json
{
  "blazeComponentLsp.enable": true,
  "blazeComponentLsp.serverPath": "",
  "blazeComponentLsp.trace.server": "off"
}
```

- `enable` — disable the extension without uninstalling
- `serverPath` — override the path to `server/index.js` (auto-detected by default)
- `trace.server` — set to `"verbose"` to debug LSP communication (see Output panel > "Blaze Component LSP")

### Neovim

#### LSP Server

**Option A: Native `vim.lsp.config` (Neovim 0.11+)**

Add to your Neovim config (e.g. `~/.config/nvim/init.lua`):

```lua
vim.lsp.config.blaze_component_lsp = {
  cmd = { "node", vim.fn.expand("~/Projects/blaze-component-lsp/server/index.js"), "--stdio" },
  filetypes = { "html" },
  root_markers = { ".meteor" },
}

vim.lsp.enable("blaze_component_lsp")
```

**Option B: lspconfig**

```lua
local lspconfig = require("lspconfig")
local configs = require("lspconfig.configs")

if not configs.blaze_component_lsp then
  configs.blaze_component_lsp = {
    default_config = {
      cmd = { "node", vim.fn.expand("~/Projects/blaze-component-lsp/server/index.js"), "--stdio" },
      filetypes = { "html" },
      root_dir = lspconfig.util.root_pattern(".meteor"),
      single_file_support = false,
    },
  }
end

lspconfig.blaze_component_lsp.setup({})
```

**Option C: Coc.nvim**

Add to `:CocConfig`:

```json
{
  "languageserver": {
    "blaze-component-lsp": {
      "command": "node",
      "args": ["~/Projects/blaze-component-lsp/server/index.js", "--stdio"],
      "filetypes": ["html"],
      "rootPatterns": [".meteor"]
    }
  }
}
```

#### Syntax Highlighting

Add the runtime path **before** your plugin manager loads (near the top of `init.lua`):

```lua
vim.opt.runtimepath:prepend(vim.fn.expand("~/Projects/blaze-component-lsp/client/neovim"))
```

This loads Spacebars syntax highlighting for HTML files, working alongside Tree-sitter.

## CLI — `blaze-check`

Run type-checking on Blaze HTML templates from the command line, similar to ESLint.

### Usage

```bash
# Run directly
node ~/Projects/blaze-component-lsp/cli/index.js [options] [file|folder...]

# Or link globally
cd ~/Projects/blaze-component-lsp
npm link
blaze-check [options] [file|folder...]
```

### Add to npm scripts

In your Meteor project's `package.json`:

```json
{
  "scripts": {
    "blaze-check": "node ~/Projects/blaze-component-lsp/cli/index.js .",
    "blaze-check:strict": "node ~/Projects/blaze-component-lsp/cli/index.js --error-on-type-mismatch ."
  }
}
```

Then run:

```bash
npm run blaze-check
```

### Options

| Flag | Description |
|------|-------------|
| `[file\|folder...]` | Paths to check (defaults to `.`) |
| `--error-on-type-mismatch` | Treat type mismatches as errors (exit code 1) |
| `--quiet` | Only show errors, suppress warnings and info |
| `--json` | Output diagnostics as JSON |
| `--no-color` | Disable colored output |
| `-h`, `--help` | Show help |

### Exit codes

- `0` — no errors (warnings may still be present)
- `1` — errors found, or `--error-on-type-mismatch` and type mismatches found

### Example output

```
imports/ui/views/index/index.html
  9:15  warning  "id" does not exist on context data of template "toggleButton"
  22:26  warning  Cannot pass arguments to template "cardsContainer" — type is unknown

2 warnings in 1 file
```

JSON mode (`--json`):

```json
[
  {
    "file": "imports/ui/views/index/index.html",
    "diagnostics": [
      {
        "line": 9,
        "column": 15,
        "severity": "warning",
        "message": "\"id\" does not exist on context data of template \"toggleButton\""
      }
    ]
  }
]
```

## Configuration

Create a `blaze-component-config.json` file in the same directory as your `.meteor` folder (the Meteor project root):

```json
{
  "errorOnTypeMismatch": false
}
```

### Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `errorOnTypeMismatch` | `boolean` | `false` | When `true`, type mismatches are reported as errors. When `false`, they are warnings. Applies to both the LSP and CLI. |

The CLI flag `--error-on-type-mismatch` overrides this config when set.

The LSP server picks up changes to this file automatically — no restart required.

## Project Structure

```
blaze-component-lsp/
├── server/                  # LSP server (Node.js)
│   ├── index.js             # Entry point
│   ├── server.js            # LSP connection handling
│   ├── parsers/
│   │   ├── spacebarsParser.js   # HTML/Spacebars template parser
│   │   └── componentParser.js   # JS/BlazeComponent parser
│   ├── indexer/
│   │   ├── projectIndex.js      # Per-project index
│   │   ├── templateIndexer.js   # HTML template index
│   │   └── componentIndexer.js  # JS component index
│   ├── providers/
│   │   ├── completionProvider.js
│   │   ├── hoverProvider.js
│   │   ├── definitionProvider.js
│   │   ├── referenceProvider.js
│   │   └── diagnosticProvider.js
│   └── utils/
│       └── uri.js
├── cli/                     # CLI type-checker
│   └── index.js
├── client/
│   ├── vscode/              # VS Code extension
│   │   ├── extension.js
│   │   ├── package.json
│   │   └── syntaxes/
│   └── neovim/              # Neovim plugin
│       ├── plugin/
│       ├── after/
│       └── lspconfig.lua
└── test/                    # Unit tests
    ├── parsers/
    ├── indexer/
    └── providers/
```

## Running Tests

```bash
npm test                    # all tests
npm run test:parsers        # parser tests only
npm run test:indexer         # indexer tests only
npm run test:providers       # provider tests only
```

## Ideas for the future

- Event selector validation. Eg if element exists in the current template. Finding unreachable code.
- Unused helper removal.
- Better go to defitions (go to definions on helpers and template context data properties).
- Better hints (for example in vs code hover hints might be useful)
- `Template.dynamic` template & data validation.
- Stricter rules and definitions for meteor native functions: `{{#if}}`, `{{#unless}}`, etc.
- Better `{{#each}}`/`{{#let}}` suggestions.
- Support for the latest Blaze `@` helpers relating to promises.
- Support for `@index` inside `{{#each}}`
