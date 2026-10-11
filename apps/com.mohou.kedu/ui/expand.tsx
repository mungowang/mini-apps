import * as React from "react";
import { cn } from "@mohou/ui";

/**
 * An editing field that rests clipped and floats open over what follows.
 * The anchor keeps the resting height, so the panel below never moves;
 * the focused editor grows past it as a floating card.
 */
export function ExpandEditor(props: {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  label: string;
  collapsedRows: number;
  textClassName: string;
  collapsedClassName?: string;
  editingClassName?: string;
  wrapClassName?: string;
  placeholder?: string;
  id?: string;
  enterCommits?: boolean;
}) {
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  const [editing, setEditing] = React.useState(false);

  /** The resting height: a fixed number of rows. */
  function collapsedHeight(): number {
    const el = ref.current;
    if (!el) return 0;
    const cs = window.getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight) || 20;
    const pad = (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0);
    return Math.round(line * props.collapsedRows + pad);
  }

  /** The full content height, measured without leaving pixel land. */
  function fullHeight(): number {
    const el = ref.current;
    if (!el) return 0;
    const prev = el.style.height;
    el.style.height = "auto";
    const full = el.scrollHeight;
    el.style.height = prev;
    return full;
  }

  React.useLayoutEffect(
    function () {
      const el = ref.current;
      const anchor = anchorRef.current;
      if (!el || !anchor) return;
      anchor.style.height = collapsedHeight() + "px";
      const target = editing ? Math.max(fullHeight(), collapsedHeight()) : collapsedHeight();
      el.style.height = target + "px";
    },
    [editing, props.value, props.collapsedRows]
  );

  function begin() {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  return (
    <div ref={anchorRef} className={cn("kedu-expand-anchor", props.wrapClassName)}>
      <div className={cn("kedu-expand-float", editing ? "kedu-expand-float-on" : "")}>
        <span
          aria-hidden
          className={cn("kedu-expand-surface", editing ? "kedu-expand-surface-on" : "")}
        />
        <textarea
          ref={ref}
          id={props.id}
          aria-label={props.label}
          rows={props.collapsedRows}
          value={props.value}
          placeholder={props.placeholder}
          onChange={function (e) {
            props.onChange(e.target.value);
          }}
          onFocus={function () {
            setEditing(true);
          }}
          onBlur={function () {
            setEditing(false);
            props.onCommit();
          }}
          onKeyDown={function (e) {
            if (props.enterCommits && e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.currentTarget.blur();
            }
          }}
          className={cn(
            "kedu-expand w-full resize-none bg-transparent outline-none",
            props.textClassName,
            editing
              ? cn("overflow-y-auto", props.editingClassName)
              : cn("overflow-hidden text-transparent", props.collapsedClassName)
          )}
        />
        {editing ? null : (
          <button
            type="button"
            aria-label={"编辑" + props.label}
            onFocus={begin}
            onClick={begin}
            className={cn(
              "kedu-expand-overlay cursor-text text-left",
              props.textClassName,
              props.collapsedRows === 1 ? "truncate" : "line-clamp-2"
            )}
          >
            {props.value ? props.value : <span className="text-muted-foreground">{props.placeholder}</span>}
          </button>
        )}
      </div>
    </div>
  );
}
