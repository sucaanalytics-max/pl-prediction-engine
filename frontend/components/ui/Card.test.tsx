import { render, screen } from "@testing-library/react";
import { Card, CardHeader, CardTitle, CardContent } from "./Card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card>test content</Card>);
    expect(screen.getByText("test content")).toBeInTheDocument();
  });

  it("applies card class by default", () => {
    const { container } = render(<Card>content</Card>);
    expect(container.firstChild).toHaveClass("card");
  });

  it("applies card-hover class when hover=true", () => {
    const { container } = render(<Card hover>content</Card>);
    expect(container.firstChild).toHaveClass("card-hover");
  });

  it("does not apply card-hover when hover is false", () => {
    const { container } = render(<Card>content</Card>);
    expect(container.firstChild).not.toHaveClass("card-hover");
  });

  it("merges custom className", () => {
    const { container } = render(<Card className="custom-class">content</Card>);
    expect(container.firstChild).toHaveClass("custom-class");
  });

  it("applies default md padding (16px)", () => {
    const { container } = render(<Card>content</Card>);
    expect((container.firstChild as HTMLElement).style.padding).toBe("16px");
  });

  it("applies no padding when padding=none", () => {
    const { container } = render(<Card padding="none">content</Card>);
    // jsdom normalizes padding: 0 to "0px"
    expect((container.firstChild as HTMLElement).style.padding).toBe("0px");
  });

  it("applies sm padding (12px)", () => {
    const { container } = render(<Card padding="sm">content</Card>);
    expect((container.firstChild as HTMLElement).style.padding).toBe("12px");
  });

  it("applies lg padding (24px)", () => {
    const { container } = render(<Card padding="lg">content</Card>);
    expect((container.firstChild as HTMLElement).style.padding).toBe("24px");
  });

  it("passes through HTML attributes", () => {
    render(<Card data-testid="my-card">content</Card>);
    expect(screen.getByTestId("my-card")).toBeInTheDocument();
  });
});

describe("CardHeader", () => {
  it("renders children", () => {
    render(<CardHeader>header content</CardHeader>);
    expect(screen.getByText("header content")).toBeInTheDocument();
  });

  it("merges custom className", () => {
    const { container } = render(<CardHeader className="extra">h</CardHeader>);
    expect(container.firstChild).toHaveClass("extra");
  });
});

describe("CardTitle", () => {
  it("renders as h2", () => {
    render(<CardTitle>My Title</CardTitle>);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("My Title");
  });

  it("merges custom className", () => {
    const { container } = render(<CardTitle className="big">t</CardTitle>);
    expect(container.firstChild).toHaveClass("big");
  });
});

describe("CardContent", () => {
  it("renders children", () => {
    render(<CardContent>body text</CardContent>);
    expect(screen.getByText("body text")).toBeInTheDocument();
  });

  it("merges custom className", () => {
    const { container } = render(<CardContent className="padded">b</CardContent>);
    expect(container.firstChild).toHaveClass("padded");
  });
});
