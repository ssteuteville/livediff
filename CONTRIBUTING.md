# Contributing to LiveDiff

Issues and pull requests are welcome.

## Running from source

You need Node 24 and pnpm (via `corepack enable`).

```bash
git clone https://github.com/ssteuteville/livediff.git
cd livediff
./install.sh          # build a real package and install it globally, plus the Claude/Codex plugins
./install.sh --dev    # or: link this working tree globally so `livediff` reflects your edits
```

`./install.sh` removes any previous global install first, so two `livediff` binaries never race on
`PATH`. Re-running it after a pull refreshes the local marketplace and plugins. To open diffs in
cmux from a source build, run `scripts/cmux-browser-setup.sh`.

```bash
pnpm dev       # Vite dev server (5173) + auto-reloading hub (4180), proxied
pnpm build     # build the server and the UI
pnpm test      # node tests
pnpm verify    # everything: typecheck, lint, node, browser, and e2e tests
```

`CLAUDE.md` covers the traps worth knowing before you change anything, and
[docs/RELEASING.md](docs/RELEASING.md) covers publishing.

## Contributor License Agreement

LiveDiff is released under the [MIT License](LICENSE), and its author may offer it under other
terms in the future, including commercial ones. To keep that possible, every contribution must
be made under the agreement below. By opening a pull request you confirm that
you agree to it, and you must sign off each commit (`git commit -s`) to record that.

1. **Copyright assignment.** You assign to Shane Steuteville ("the Maintainer") all right, title,
   and interest, including copyright, in your contribution. Where assignment is not possible under
   applicable law, you grant the Maintainer a perpetual, worldwide, exclusive, royalty-free,
   irrevocable license to use, modify, sublicense, and distribute your contribution under any
   terms, including proprietary and commercial ones.
2. **Your right to contribute.** The contribution is your original work, or you otherwise have
   the right to submit it under these terms. If your employer has rights to work you create, you
   have their permission to make the contribution under this agreement.
3. **Patents.** You grant the Maintainer and recipients of the software a perpetual, worldwide,
   royalty-free, irrevocable patent license for any of your patent claims that your contribution
   necessarily infringes, alone or combined with LiveDiff.
4. **No obligation.** The Maintainer is not required to accept or use your contribution. You
   receive no compensation, and you provide the contribution "as is", without warranties.

If you cannot agree to these terms, please open an issue describing the change instead of
sending code.
