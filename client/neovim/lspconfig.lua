-- Blaze Component LSP — Neovim setup via lspconfig
--
-- Option 1: Add as a custom server in lspconfig
-- Place this in your Neovim config (e.g., ~/.config/nvim/lua/lsp/blaze.lua)
-- and require it from your init.lua.

local lspconfig = require("lspconfig")
local configs = require("lspconfig.configs")

-- Only define if not already defined
if not configs.blaze_component_lsp then
  configs.blaze_component_lsp = {
    default_config = {
      -- Update this path to wherever you installed blaze-component-lsp
      cmd = { "node", vim.fn.expand("~/Projects/blaze-component-lsp/server/index.js"), "--stdio" },
      filetypes = { "html" },
      root_dir = lspconfig.util.root_pattern(".meteor"),
      settings = {},
      single_file_support = false,
    },
  }
end

lspconfig.blaze_component_lsp.setup({
  on_attach = function(client, bufnr)
    -- Optional: set up keymaps for this LSP
    local opts = { buffer = bufnr, noremap = true, silent = true }
    vim.keymap.set("n", "gd", vim.lsp.buf.definition, opts)
    vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
    vim.keymap.set("n", "gr", vim.lsp.buf.references, opts)
  end,
})

-- Option 2: Manual setup without lspconfig (Neovim 0.8+)
--
-- vim.api.nvim_create_autocmd("FileType", {
--   pattern = "html",
--   callback = function()
--     local root = vim.fs.find(".meteor", { upward = true, path = vim.fn.expand("%:p:h") })
--     if #root > 0 then
--       vim.lsp.start({
--         name = "blaze-component-lsp",
--         cmd = { "node", vim.fn.expand("~/Projects/blaze-component-lsp/server/index.js"), "--stdio" },
--         root_dir = vim.fs.dirname(root[1]),
--       })
--     end
--   end,
-- })
