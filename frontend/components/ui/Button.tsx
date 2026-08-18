import { ButtonHTMLAttributes, CSSProperties } from "react";
import clsx from "clsx";

type ButtonVariant = "primary" | "ghost" | "outline";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: "text-[var(--bg)] border",
  ghost: "bg-transparent border border-transparent",
  outline: "bg-transparent border",
};

const VARIANT_INLINE: Record<ButtonVariant, CSSProperties> = {
  // Identity, not a verdict: a primary button is "ours to press", and it must not
  // read as the hue that means "agrees with the market".
  primary: { background: "var(--brand)", borderColor: "var(--brand)" },
  ghost: { color: "var(--text-3)" },
  outline: { color: "var(--text-2)", borderColor: "var(--border)" },
};

const SIZE_STYLES: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-sm",
};

export function Button({
  variant = "ghost",
  size = "md",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-none font-medium transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        VARIANT_STYLES[variant],
        SIZE_STYLES[size],
        className
      )}
      style={VARIANT_INLINE[variant]}
      {...props}
    >
      {children}
    </button>
  );
}
