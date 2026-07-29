" Spacebars / Blaze template syntax highlighting for Neovim
" Injected on top of the built-in HTML syntax
"
" Install: symlink or copy this file to ~/.config/nvim/after/syntax/html.vim
"          (or add this repo's client/neovim dir to runtimepath)

if exists('b:current_syntax_spacebars')
  finish
endif

" --- Comments: {{!-- ... --}} and {{! ... }} ---
syn region spacebar_comment start="{{!--" end="--}}" containedin=ALL
syn region spacebar_comment start="{{!" end="}}" containedin=ALL
hi def link spacebar_comment Comment

" --- Raw expressions: {{{...}}} (must come before mustache) ---
syn region spacebar_raw matchgroup=spacebar_delim start="{{{" end="}}}" containedin=ALL contains=@spacebar_expr oneline
hi def link spacebar_raw Special

" --- Block close: {{/keyword}} ---
syn match spacebar_block_close "{{/\w\+}}" containedin=ALL contains=spacebar_delim,spacebar_block_keyword
hi def link spacebar_block_close Keyword

" --- Block open: {{#keyword ...}} / {{else}} / {{else if ...}} ---
syn region spacebar_block matchgroup=spacebar_delim start="{{[#]" end="}}" containedin=ALL contains=@spacebar_expr,spacebar_block_keyword oneline
syn match spacebar_else "{{else\s*}}" containedin=ALL contains=spacebar_delim,spacebar_block_keyword
syn region spacebar_else_if matchgroup=spacebar_delim start="{{else\s\+if\>" end="}}" containedin=ALL contains=@spacebar_expr,spacebar_block_keyword oneline
hi def link spacebar_block Statement
hi def link spacebar_else Keyword
hi def link spacebar_else_if Statement

" --- Partial: {{> name ...}} ---
syn region spacebar_partial matchgroup=spacebar_delim start="{{>" end="}}" containedin=ALL contains=spacebar_partial_name,@spacebar_expr oneline
syn match spacebar_partial_name "\%({{>\s*\)\@<=[A-Za-z_][A-Za-z0-9_.]*" contained
hi def link spacebar_partial PreProc
hi def link spacebar_partial_name Type

" --- Regular mustache: {{...}} ---
syn region spacebar_mustache matchgroup=spacebar_delim start="{{" end="}}" containedin=ALL contains=@spacebar_expr oneline
hi def link spacebar_mustache Identifier

" --- Expression contents (shared) ---
syn cluster spacebar_expr contains=spacebar_block_keyword,spacebar_in_keyword,spacebar_string_double,spacebar_string_single,spacebar_number,spacebar_boolean,spacebar_key_value,spacebar_sub_expr,spacebar_dotted_path,spacebar_identifier

" Block keywords
syn keyword spacebar_block_keyword if unless each with let else contained
hi def link spacebar_block_keyword Keyword

" 'in' keyword ({{#each item in list}})
syn keyword spacebar_in_keyword in contained
hi def link spacebar_in_keyword Keyword

" Strings
syn region spacebar_string_double start=+"+ end=+"+ contained
syn region spacebar_string_single start=+'+ end=+'+ contained
hi def link spacebar_string_double String
hi def link spacebar_string_single String

" Numbers
syn match spacebar_number "\<\d\+\%(\.\d\+\)\?\>" contained
hi def link spacebar_number Number

" Boolean / null / undefined
syn keyword spacebar_boolean true false null undefined contained
hi def link spacebar_boolean Boolean

" Key=value parameters (template=section.template)
syn match spacebar_key_value "[A-Za-z_][A-Za-z0-9_]*\ze=" contained
hi def link spacebar_key_value Identifier

" Sub-expressions: (helperName arg)
syn region spacebar_sub_expr matchgroup=spacebar_paren start="(" end=")" contained contains=@spacebar_expr
hi def link spacebar_paren Delimiter

" Dotted paths: object.property.nested
syn match spacebar_dotted_path "[A-Za-z_][A-Za-z0-9_]*\%(\.[A-Za-z_][A-Za-z0-9_]*\)\+" contained contains=spacebar_dot
syn match spacebar_dot "\." contained
hi def link spacebar_dotted_path Identifier
hi def link spacebar_dot Delimiter

" Plain identifiers (helpers, context fields)
syn match spacebar_identifier "[A-Za-z_@][A-Za-z0-9_]*" contained
hi def link spacebar_identifier Identifier

" Delimiters: {{ }} {{{ }}}
syn match spacebar_delim "{{{\|}}}\|{{\|}}"\|"{{/\|{{#\|{{>" contained
hi def link spacebar_delim Delimiter

" <template name="..."> tag
syn match spacebar_template_tag "<template\s\+name=" containedin=ALL contains=spacebar_template_keyword
syn keyword spacebar_template_keyword template contained
hi def link spacebar_template_tag Tag
hi def link spacebar_template_keyword Tag

let b:current_syntax_spacebars = 1
