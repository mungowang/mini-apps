import * as React from "react";
import { Icon, cn } from "@mohou/ui";

import type { Schedule } from "../shared/model";
import type { Priority } from "../shared/types";
import { PRIORITY_LABEL, PRIORITY_TITLE } from "../shared/types";

const HAIR = "color-mix(in oklab, var(--foreground) 18%, transparent)";

export function Mono(props: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11px] tabular-nums", props.className)}>{props.children}</span>;
}

/** Quiet monochrome mark for "today is clear" — matches kedu tick language, not a busy undraw. */
export function IlluClear(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 88"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={props.className}
      aria-hidden="true"
    >
      <rect x="18" y="14" width="84" height="60" rx="10" stroke="currentColor" strokeWidth="1.5" opacity="0.22" />
      <path
        d="M38 34h44M38 44h32M38 54h38"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.18"
      />
      <circle cx="86" cy="58" r="18" fill="var(--background)" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M78.5 58.5l5 5 10-12"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TickBar(props: { ratio: number; ticks?: number; celebrate?: boolean }) {
  const total = props.ticks === undefined ? 18 : props.ticks;
  const rate = props.ratio < 0 ? 0 : props.ratio > 1 ? 1 : props.ratio;
  const filled = Math.round(rate * total);
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < total; i++) {
    const on = i < filled;
    cells.push(
      <span
        key={i}
        className={props.celebrate && on ? "kedu-tick-cheer" : undefined}
        style={{
          height: 12,
          width: 2,
          borderRadius: 1,
          backgroundColor: on ? "var(--foreground)" : HAIR,
          animationDelay: props.celebrate ? String(i * 40) + "ms" : undefined,
        }}
      />
    );
  }
  return (
    <span className="inline-flex items-end gap-[3px]" aria-hidden="true">
      {cells}
    </span>
  );
}

export function PriorityMark(props: { priority: Priority; onCycle?: () => void }) {
  const title = PRIORITY_LABEL[props.priority] + " " + PRIORITY_TITLE[props.priority];
  // Fixed 16×16 slot (same as TaskCheck) so the glyph centers with the radio on the row.
  const bars = (
    <span className="inline-flex h-[11px] w-[14px] items-end justify-center gap-0.5" aria-hidden="true">
      {[1, 2, 3, 4].map(function (i) {
        const on = i >= props.priority;
        return (
          <span
            key={i}
            style={{
              width: 2,
              height: 3 + i * 2,
              borderRadius: 1,
              backgroundColor: on ? "var(--foreground)" : HAIR,
            }}
          />
        );
      })}
    </span>
  );
  if (!props.onCycle) {
    return (
      <span title={title} className="grid size-4 shrink-0 place-items-center">
        {bars}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={title + "，点击降低一级"}
      aria-label={title + "，点击降低一级"}
      onClick={function (e) {
        e.stopPropagation();
        if (props.onCycle) props.onCycle();
      }}
      className="grid size-4 shrink-0 place-items-center rounded-sm hover:bg-muted"
    >
      {bars}
    </button>
  );
}

export function TaskCheck(props: { done: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.done ? "标为未完成" : "标为完成"}
      aria-pressed={props.done}
      onClick={function (e) {
        e.stopPropagation();
        props.onToggle();
      }}
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full border",
        props.done ? "border-foreground bg-foreground text-background" : "kedu-edge"
      )}
    >
      {props.done ? <Icon.Check size={10} strokeWidth={2.8} /> : null}
    </button>
  );
}

export function DueText(props: { meta: Schedule | null }) {
  if (!props.meta) return null;
  const tone =
    props.meta.tone === "overdue" ? "text-destructive" : props.meta.tone === "today" ? "text-foreground" : "text-muted-foreground";
  return <span className={cn("shrink-0 font-mono text-[11px] tabular-nums", tone)}>{props.meta.label}</span>;
}

export function SubtaskTicks(props: { done: number; total: number; invert?: boolean }) {
  const n = Math.min(props.total, 8);
  const on = props.invert ? "var(--background)" : "var(--foreground)";
  const off = props.invert ? "color-mix(in oklab, var(--background) 38%, transparent)" : HAIR;
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    cells.push(
      <span
        key={i}
        style={{
          width: 7,
          height: 2,
          borderRadius: 1,
          backgroundColor: i < props.done ? on : off,
        }}
      />
    );
  }
  return <span className="inline-flex items-center gap-0.5">{cells}</span>;
}
