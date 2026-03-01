import { render, screen } from "@testing-library/react";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("renders children", () => {
    render(<Badge>HIGH</Badge>);
    expect(screen.getByText("HIGH")).toBeInTheDocument();
  });

  it("applies badge-slate class by default", () => {
    const { container } = render(<Badge>DEFAULT</Badge>);
    expect(container.firstChild).toHaveClass("badge-slate");
  });

  it("applies badge-green class for green variant", () => {
    const { container } = render(<Badge variant="green">GO</Badge>);
    expect(container.firstChild).toHaveClass("badge-green");
  });

  it("applies badge-amber class for amber variant", () => {
    const { container } = render(<Badge variant="amber">MEDIUM</Badge>);
    expect(container.firstChild).toHaveClass("badge-amber");
  });

  it("applies badge-red class for red variant", () => {
    const { container } = render(<Badge variant="red">LOW</Badge>);
    expect(container.firstChild).toHaveClass("badge-red");
  });

  it("applies badge-sky class for sky variant", () => {
    const { container } = render(<Badge variant="sky">INFO</Badge>);
    expect(container.firstChild).toHaveClass("badge-sky");
  });

  it("applies badge class for violet variant", () => {
    const { container } = render(<Badge variant="violet">CONF</Badge>);
    expect(container.firstChild).toHaveClass("badge");
  });

  it("applies violet inline color style", () => {
    const { container } = render(<Badge variant="violet">CONF</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.style.color).toBe("var(--info)");
  });

  it("does not apply inline styles for non-violet variants", () => {
    const { container } = render(<Badge variant="green">X</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.style.color).toBe("");
  });

  it("merges custom className", () => {
    const { container } = render(<Badge className="extra">badge</Badge>);
    expect(container.firstChild).toHaveClass("extra");
  });

  it("renders as a span element", () => {
    const { container } = render(<Badge>label</Badge>);
    expect(container.firstChild?.nodeName).toBe("SPAN");
  });
});
