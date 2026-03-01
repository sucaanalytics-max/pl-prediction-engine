import { HTMLAttributes } from "react";
import clsx from "clsx";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

export function Card({ hover = false, padding = "md", className, children, ...props }: CardProps) {
  return (
    <div
      className={clsx(hover ? "card-hover" : "card", className)}
      style={{ padding: padding === "none" ? 0 : padding === "sm" ? "12px" : padding === "lg" ? "24px" : "16px" }}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx("flex items-center justify-between mb-4", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={clsx("text-sm font-semibold uppercase tracking-wider", className)}
      style={{ color: "var(--text-2)", letterSpacing: "0.06em" }}
      {...props}
    >
      {children}
    </h2>
  );
}

export function CardContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx(className)} {...props}>
      {children}
    </div>
  );
}
