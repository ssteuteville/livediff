// An ambient script, not a module: no import/export, so `interface Window` merges with the global
// one directly and the file needs no `export {}` to opt into module scope.
interface Window {
  __LIVEDIFF_RENDERERS__?: string[];
}
