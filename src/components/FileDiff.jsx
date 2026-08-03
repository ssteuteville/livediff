import { useMemo } from "react";
import { DiffView, DiffModeEnum, SplitSide } from "@git-diff-view/react";
import CommentComposer from "./CommentComposer.jsx";
import CommentThread from "./CommentThread.jsx";

const sideToStr = (side) => (side === SplitSide.old ? "old" : "new");

// The library's enum stays behind this module's lazy boundary; callers pass "split" | "unified".
const VIEW_MODE = { split: DiffModeEnum.Split, unified: DiffModeEnum.Unified };

const STATUS_STYLES = {
  added: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300",
  deleted: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  modified: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  renamed: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
};

export default function FileDiff({ file, comments, mode, theme, onAddComment, onCommentAction }) {
  const data = useMemo(
    () => ({
      oldFile: { fileName: file.oldPath, fileLang: file.lang },
      newFile: { fileName: file.path, fileLang: file.lang },
      hunks: file.patch ? [file.patch] : [],
    }),
    [file]
  );

  const extendData = useMemo(() => {
    const ext = { oldFile: {}, newFile: {} };
    for (const c of comments) {
      const bucket = c.side === "old" ? ext.oldFile : ext.newFile;
      if (!bucket[c.line]) bucket[c.line] = { data: { line: c.line, side: c.side, items: [] } };
      bucket[c.line].data.items.push(c);
    }
    return ext;
  }, [comments]);

  const openCount = comments.filter((c) => c.status === "open").length;

  return (
    <section className="mb-4 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        <span className={"rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase " + (STATUS_STYLES[file.status] || STATUS_STYLES.modified)}>
          {file.status}
        </span>
        <span className="font-mono text-neutral-800 dark:text-neutral-100">{file.path}</span>
        {file.additions > 0 && <span className="text-xs text-green-600 dark:text-green-400">+{file.additions}</span>}
        {file.deletions > 0 && <span className="text-xs text-red-600 dark:text-red-400">−{file.deletions}</span>}
        {openCount > 0 && (
          <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
            {openCount} open comment{openCount > 1 ? "s" : ""}
          </span>
        )}
      </header>

      {file.binary ? (
        <div className="px-3 py-6 text-center text-sm text-neutral-500">Binary file not shown</div>
      ) : (
        <div className="text-[13px]">
          <DiffView
            data={data}
            diffViewMode={VIEW_MODE[mode] ?? DiffModeEnum.Split}
            diffViewTheme={theme}
            diffViewHighlight
            diffViewAddWidget
            diffViewWrap
            extendData={extendData}
            renderWidgetLine={({ diffFile, side, lineNumber, onClose }) => {
              const sideStr = sideToStr(side);
              const plain =
                sideStr === "old" ? diffFile.getOldPlainLine(lineNumber) : diffFile.getNewPlainLine(lineNumber);
              return (
                <CommentComposer
                  onCancel={onClose}
                  onSubmit={(body) => {
                    onAddComment({
                      file: file.path,
                      side: sideStr,
                      line: lineNumber,
                      lineContent: plain?.value ?? "",
                      body,
                    });
                    onClose();
                  }}
                />
              );
            }}
            renderExtendLine={({ data: lineData }) => (
              <CommentThread
                comments={lineData.items}
                onResolve={(id) => onCommentAction(id, { status: "resolved" })}
                onReopen={(id) => onCommentAction(id, { status: "open" })}
                onDelete={(id) => onCommentAction(id, { delete: true })}
                onReply={(id, body) => onCommentAction(id, { reply: { author: "user", body } })}
              />
            )}
          />
        </div>
      )}
    </section>
  );
}
