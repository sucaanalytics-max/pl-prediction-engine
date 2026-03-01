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
    background: "rgba(139, 92, 246, 0.12)",
    color: "#a78bfa",
    border: "1px solid rgba(139, 92, 246, 0.2)",
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
