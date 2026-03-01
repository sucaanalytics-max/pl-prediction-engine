import { HTMLAttributes } from "react";
import clsx from "clsx";

type BadgeVariant = "green" | "amber" | "red" | "sky" | "slate" | "violet";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  green: "badge-green",
  amber: "badge-amber",
  red: "badge-red",
  sky: "badge-sky",
  slate: "badge-slate",
  violet: "badge",
};

const VARIANT_STYLE: Record<BadgeVariant, React.CSSProperties> = {
  green: {},
  amber: {},
  red: {},
  sky: {},
  slate: {},
  violet: {
    background: "var(--info-muted)",
    color: "var(--info)",
    border: "1px solid var(--info-border)",
  },
};

export function Badge({ variant = "slate", className, children, ...props }: BadgeProps) {
  return (
    <span
      className={clsx(VARIANT_CLASS[variant], className)}
      style={VARIANT_STYLE[variant]}
      {...props}
    >
      {children}
    </span>
  );
}
