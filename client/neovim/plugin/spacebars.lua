-- Spacebars / Blaze template syntax highlighting for Neovim
-- Works with both Tree-sitter and classic vim syntax
--
-- Install: add to runtimepath in init.lua (near the top, before plugin manager):
--   vim.opt.runtimepath:prepend(vim.fn.expand("~/Projects/blaze-component-lsp/client/neovim"))

local function apply_spacebars_highlights(bufnr)
  if vim.b[bufnr].spacebars_matches then
    return
  end
  vim.b[bufnr].spacebars_matches = true

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

  local win = vim.fn.bufwinid(bufnr)
  if win == -1 then
    return
  end

  -- Priority 200 to render above Tree-sitter (default 100)
  local p = 200

  vim.api.nvim_win_call(win, function()
    vim.fn.matchadd("SpacebarsComment", "{{!--.\\{-}--}}", p)
    vim.fn.matchadd("SpacebarsComment", "{{!.\\{-}}}", p)

    vim.fn.matchadd("SpacebarsRaw", "{{{.\\{-}}}}", p)

    vim.fn.matchadd("SpacebarsKeyword", "{{[#/]\\(if\\|unless\\|each\\|with\\|let\\)\\>", p)
    vim.fn.matchadd("SpacebarsKeyword", "{{else\\(\\s\\+if\\)\\=\\>", p)
    vim.fn.matchadd("SpacebarsKeyword", "\\<\\(if\\|unless\\|each\\|with\\|let\\|else\\|in\\)\\>}}", p)
    vim.fn.matchadd("SpacebarsKeyword", "{{/\\w\\+}}", p)

    vim.fn.matchadd("SpacebarsPartial", "{{>\\s*[A-Za-z_.][A-Za-z0-9_.]*", p)

    vim.fn.matchadd("SpacebarsHelper", "{{\\ze[^!>#/{]", p)
    vim.fn.matchadd("SpacebarsHelper", "[^}]\\zs}}", p)

    vim.fn.matchadd("SpacebarsDelimiter", "{{{\\|{{{\\@!\\|}}}\\|}}}\\@!", p)

    vim.fn.matchadd("SpacebarsString", '{{[^}]*\\zs"[^"]*"\\ze[^}]*}}', p)
    vim.fn.matchadd("SpacebarsString", "{{[^}]*\\zs'[^']*'\\ze[^}]*}}", p)

    vim.fn.matchadd("SpacebarsParam", "\\<[A-Za-z_][A-Za-z0-9_]*\\ze=", p)
  end)
end

vim.api.nvim_create_autocmd("FileType", {
  pattern = "html",
  callback = function(args)
    apply_spacebars_highlights(args.buf)
  end,
  desc = "Spacebars syntax highlighting for Blaze templates",
})
