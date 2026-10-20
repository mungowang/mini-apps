import { useEffect, useId, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Icon } from "@mohou/ui"

/** Encode multi-select filter values into the string-backed filter map. */
export function parseMultiFilter(raw: string | undefined | null): string[] {
  return String(raw ?? "")
    .split(/\s*\|\s*/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function joinMultiFilter(values: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of values) {
    const text = item.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out.join(" | ")
}

/** Searchable multi-select for enum / ref home filters. Single-line field; overflow as +N. */
export function FilterMultiSelect({
  values,
  options,
  placeholder = "输入或选择",
  onChange,
}: {
  values: string[]
  options: string[]
  placeholder?: string
  onChange: (values: string[]) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [box, setBox] = useState<DOMRect | null>(null)
  const selected = useMemo(() => new Set(values), [values])

  const allOptions = useMemo(() => {
    const known = new Set(options)
    const extra = values.filter((item) => !known.has(item))
    return [...extra, ...options]
  }, [options, values])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allOptions
    return allOptions.filter((item) => item.toLowerCase().includes(q))
  }, [allOptions, query])

  function measure() {
    const el = rootRef.current
    if (!el) return
    setBox(el.getBoundingClientRect())
  }

  function openMenu() {
    measure()
    setOpen(true)
  }

  function closeMenu() {
    setOpen(false)
    setQuery("")
  }

  function toggle(value: string) {
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange([...next])
  }

  function remove(value: string) {
    onChange(values.filter((item) => item !== value))
  }

  function clearAll() {
    onChange([])
    setQuery("")
    inputRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    measure()
    const onScroll = () => measure()
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      closeMenu()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu()
    }
    window.addEventListener("resize", onScroll)
    window.addEventListener("scroll", onScroll, true)
    document.addEventListener("pointerdown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("resize", onScroll)
      window.removeEventListener("scroll", onScroll, true)
      document.removeEventListener("pointerdown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const menu = open && box
    ? createPortal(
      <div
        ref={menuRef}
        className="view-filter-multi-menu"
        style={{
          position: "fixed",
          top: box.bottom + 6,
          left: box.left,
          width: Math.max(box.width, 180),
          zIndex: 80,
        }}
        role="listbox"
        id={listId}
        aria-multiselectable="true"
      >
        {filtered.length === 0 ? (
          <p className="view-filter-multi-empty">
            {query.trim() ? "无匹配项" : "暂无可选项"}
          </p>
        ) : (
          filtered.map((option) => {
            const on = selected.has(option)
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={on}
                className={"view-filter-multi-option" + (on ? " is-on" : "")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggle(option)}
              >
                <span className={"view-filter-multi-check" + (on ? " is-on" : "")} aria-hidden="true">
                  {on ? <Icon.Check size={12} strokeWidth={2.6} /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate text-left">{option}</span>
              </button>
            )
          })
        )}
        {values.length > 0 && (
          <button
            type="button"
            className="view-filter-multi-clear-all"
            onMouseDown={(event) => event.preventDefault()}
            onClick={clearAll}
          >
            清除已选（{values.length}）
          </button>
        )}
      </div>,
      document.body,
    )
    : null

  // one line only: first chip(s) + +N, never wrap the field height
  const visibleChips = values.slice(0, values.length > 2 ? 1 : 2)
  const hiddenCount = Math.max(0, values.length - visibleChips.length)

  return (
    <div
      ref={rootRef}
      className={"view-filter-multi-field" + (values.length ? " has-value" : "") + (open ? " is-open" : "")}
      title={values.length ? values.join(" · ") : undefined}
      onClick={() => {
        openMenu()
        inputRef.current?.focus()
      }}
    >
      <div className="view-filter-multi-chips">
        {visibleChips.map((value) => (
          <span key={value} className="view-filter-multi-chip">
            <span className="view-filter-multi-chip-text">{value}</span>
            <button
              type="button"
              className="view-filter-multi-chip-x"
              aria-label={"移除 " + value}
              onClick={(event) => {
                event.stopPropagation()
                remove(value)
              }}
            >
              <Icon.X size={11} />
            </button>
          </span>
        ))}
        {hiddenCount > 0 && (
          <span className="view-filter-multi-more" aria-label={"另有 " + hiddenCount + " 项"}>
            +{hiddenCount}
          </span>
        )}
        <input
          ref={inputRef}
          className="view-filter-multi-input"
          value={query}
          placeholder={values.length ? "搜索…" : placeholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          onFocus={openMenu}
          onChange={(event) => {
            setQuery(event.target.value)
            if (!open) openMenu()
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && !query && values.length) {
              event.preventDefault()
              remove(values[values.length - 1]!)
              return
            }
            if (event.key === "Enter") {
              event.preventDefault()
              const exact = filtered.find((item) => item.toLowerCase() === query.trim().toLowerCase())
                ?? (filtered.length === 1 ? filtered[0] : undefined)
              if (exact) {
                toggle(exact)
                setQuery("")
              }
            }
            if (event.key === "Escape") {
              event.preventDefault()
              closeMenu()
              inputRef.current?.blur()
            }
          }}
        />
      </div>
      {values.length > 0 ? (
        <button
          type="button"
          className="view-filter-multi-clear"
          aria-label="清除全部"
          onClick={(event) => {
            event.stopPropagation()
            clearAll()
          }}
        >
          <Icon.X size={13} />
        </button>
      ) : (
        <Icon.ChevronDown size={14} className="view-filter-multi-chev" aria-hidden="true" />
      )}
      {menu}
    </div>
  )
}
