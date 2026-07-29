-- Spacebars / Blaze template syntax highlighting for Neovim
-- Works with both Tree-sitter and classic vim syntax
--
-- Install: add to runtimepath in init.lua:
--   vim.opt.runtimepath:append(vim.fn.expand("~/Projects/blaze-component-lsp/client/neovim"))

if vim.b.spacebars_matches then
  return
end
vim.b.spacebars_matches = true

local function hi(group, opts)
  vim.api.nvim_set_hl(0, group, opts)
end

hi("SpacebarsDelimiter", { link = "Delimiter" })
hi("SpacebarsComment",   { link = "Comment" })
hi("SpacebarsKeyword",   { link = "Keyword" })
hi("SpacebarsPartial",   { link = "Type" })
hi("SpacebarsRaw",       { link = "WarningMsg" })
hi("SpacebarsHelper",    { link = "Function" })
hi("SpacebarsString",    { link = "String" })
hi("SpacebarsParam",     { link = "Identifier" })
hi("SpacebarsDot",       { link = "Delimiter" })

-- Priority 200 to render above Tree-sitter (default 100)
local p = 200

-- Comments: {{!-- ... --}} and {{! ... }}
vim.fn.matchadd("SpacebarsComment", "{{!--.\\{-}--}}", p)
vim.fn.matchadd("SpacebarsComment", "{{!.\\{-}}}", p)

-- Raw expressions: {{{...}}}
vim.fn.matchadd("SpacebarsRaw", "{{{.\\{-}}}}", p)

-- Block keywords: {{#if}}, {{/each}}, {{else}}, etc.
vim.fn.matchadd("SpacebarsKeyword", "{{[#/]\\(if\\|unless\\|each\\|with\\|let\\)\\>", p)
vim.fn.matchadd("SpacebarsKeyword", "{{else\\(\\s\\+if\\)\\=\\>", p)
vim.fn.matchadd("SpacebarsKeyword", "\\<\\(if\\|unless\\|each\\|with\\|let\\|else\\|in\\)\\>}}", p)

-- Block close: the /keyword part
vim.fn.matchadd("SpacebarsKeyword", "{{/\\w\\+}}", p)

-- Partial: {{> templateName ...}}
vim.fn.matchadd("SpacebarsPartial", "{{>\\s*[A-Za-z_.][A-Za-z0-9_.]*", p)

-- Regular mustache: {{helper}} or {{field}}
vim.fn.matchadd("SpacebarsHelper", "{{\\ze[^!>#/{]", p)
vim.fn.matchadd("SpacebarsHelper", "[^}]\\zs}}", p)

-- Delimiters: {{ and }}
vim.fn.matchadd("SpacebarsDelimiter", "{{{\\|{{{\\@!\\|}}}\\|}}}\\@!", p)

-- Strings inside expressions
vim.fn.matchadd("SpacebarsString", '{{[^}]*\\zs"[^"]*"\\ze[^}]*}}', p)
vim.fn.matchadd("SpacebarsString", "{{[^}]*\\zs'[^']*'\\ze[^}]*}}", p)

-- key=value params
vim.fn.matchadd("SpacebarsParam", "\\<[A-Za-z_][A-Za-z0-9_]*\\ze=", p)
