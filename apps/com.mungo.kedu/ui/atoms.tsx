import * as React from "react";
import { Icon, cn } from "@mohou/ui";

import type { Schedule } from "../shared/model";
import type { Priority } from "../shared/types";
import { PRIORITY_LABEL, PRIORITY_TITLE } from "../shared/types";

const HAIR = "color-mix(in oklab, var(--foreground) 18%, transparent)";

export function Mono(props: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11px] tabular-nums", props.className)}>{props.children}</span>;
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
  const bars = [1, 2, 3, 4].map(function (i) {
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
  });
  const body = <span className="inline-flex items-end gap-0.5">{bars}</span>;
  if (!props.onCycle) return <span title={title}>{body}</span>;
  return (
    <button
      type="button"
      title={title + "，点击降低一级"}
      aria-label={title + "，点击降低一级"}
      onClick={function (e) {
        e.stopPropagation();
        if (props.onCycle) props.onCycle();
      }}
      className="inline-flex shrink-0 items-end rounded-sm px-0.5 py-1 hover:bg-muted"
    >
      {body}
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
        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
        props.done ? "border-foreground bg-foreground text-background" : "border-input hover:border-foreground"
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

export function SubtaskTicks(props: { done: number; total: number }) {
  const n = Math.min(props.total, 8);
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    cells.push(
      <span
        key={i}
        style={{
          width: 7,
          height: 2,
          borderRadius: 1,
          backgroundColor: i < props.done ? "var(--foreground)" : HAIR,
        }}
      />
    );
  }
  return <span className="inline-flex items-center gap-0.5">{cells}</span>;
}
