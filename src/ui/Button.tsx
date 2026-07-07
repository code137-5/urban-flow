import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'

type Variant = 'primary' | 'secondary' | 'tertiary' | 'ghost'

interface CommonProps {
  variant?: Variant
  children: ReactNode
  /** Optional trailing icon/adornment (e.g. an arrow glyph). */
  trailing?: ReactNode
}

type ButtonAsButton = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { href?: undefined }
type ButtonAsLink = CommonProps & {
  href: string
  onClick?: () => void
}

/**
 * Carbon button (Gray 100 dark). Square 0px corners, 12/16 padding, 14px label.
 * Renders as <a> when `href` is set, else <button>.
 */
export function Button(props: ButtonAsButton | ButtonAsLink) {
  const { variant = 'primary', children, trailing } = props
  const cls = `${styles.btn} ${styles[variant]}`

  if ('href' in props && props.href !== undefined) {
    return (
      <a className={cls} href={props.href} onClick={props.onClick}>
        {children}
        {trailing && <span className={styles.trailing}>{trailing}</span>}
      </a>
    )
  }

  const { variant: _v, children: _c, trailing: _t, ...rest } = props as ButtonAsButton
  return (
    <button className={cls} {...rest}>
      {children}
      {trailing && <span className={styles.trailing}>{trailing}</span>}
    </button>
  )
}
