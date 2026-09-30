import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { snapClamp } from './snap'
import styles from './NumberInput.module.css'

export interface NumberInputProps {
  value: number
  /** Fires only on a commit that actually changes the (snapped, clamped) value. */
  onChange: (next: number) => void
  min: number
  max: number
  /** Grid anchored at `min`; typed values snap onto it. */
  step: number
  ariaLabel: string
  disabled?: boolean
  /** Display text for a committed value. Default en-US thousands ("15,000"). */
  format?: (v: number) => string
  className?: string
}

const defaultFormat = (v: number) => v.toLocaleString('en-US')

/** Digits only ("15,000" → 15000); null for nothing usable. */
function parseDraft(text: string): number | null {
  // Only an unsigned integer counts, thousands separators and spaces allowed
  // ("8,000", "8 000"). A sign or a decimal point makes the draft invalid rather
  // than silently becoming another number ("8000.5" must not read as 80005).
  const m = /^\s*([\d,\s]+)\s*$/.exec(text)
  if (!m) return null
  const digits = m[1].replace(/[,\s]/g, '')
  if (digits === '') return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

/**
 * Carbon number input, dark: a text field with −/+ steppers, 0px corners, a
 * strong bottom hairline and a focus ring around the whole control.
 *
 * `type="text"` + `role="spinbutton"`, not `type="number"`: the native field
 * cannot show thousands separators and commits on every keystroke. Typing only
 * edits a local draft; the value is committed (snapped to `step`, clamped into
 * [min, max]) on blur, Enter, ↑/↓ or a stepper click. Escape, an empty field or
 * garbage revert to the current value. The steppers are `tabIndex=-1` and keep
 * focus in the field on press, so the keyboard path is the field alone.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  ariaLabel,
  disabled = false,
  format = defaultFormat,
  className,
}: NumberInputProps) {
  // Text being typed; null = show the formatted committed value.
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (raw: number | null) => {
    setDraft(null)
    if (raw === null) return
    const next = snapClamp(raw, min, step, min, max)
    if (next !== value) onChange(next)
  }

  /** Where ↑/↓ and the steppers start from: the draft being typed, else the value. */
  const base = () => (draft === null ? value : (parseDraft(draft) ?? value))

  const nudge = (dir: 1 | -1) => {
    if (disabled) return
    commit(base() + dir * step)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'Enter':
        e.preventDefault()
        if (draft !== null) commit(parseDraft(draft))
        break
      case 'Escape':
        if (draft !== null) {
          e.preventDefault()
          setDraft(null)
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        nudge(1)
        break
      case 'ArrowDown':
        e.preventDefault()
        nudge(-1)
        break
    }
  }

  const rootClass = [styles.root, disabled ? styles.disabled : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass}>
      <input
        type="text"
        inputMode="numeric"
        role="spinbutton"
        className={styles.input}
        aria-label={ariaLabel}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={format(value)}
        value={draft ?? format(value)}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) commit(parseDraft(draft))
        }}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        tabIndex={-1}
        className={styles.stepper}
        aria-label={`Decrease ${ariaLabel}`}
        disabled={disabled || base() <= min}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => nudge(-1)}
      >
        <span aria-hidden="true">−</span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={styles.stepper}
        aria-label={`Increase ${ariaLabel}`}
        disabled={disabled || base() >= max}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => nudge(1)}
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  )
}
