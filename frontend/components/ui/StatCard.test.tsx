import { render, screen } from "@testing-library/react";
import { StatCard } from "./StatCard";

describe("StatCard", () => {
  it("renders the label", () => {
    render(<StatCard label="Goals Scored" value="23" />);
    expect(screen.getByText("Goals Scored")).toBeInTheDocument();
  });

  it("renders a string value", () => {
    render(<StatCard label="Brier" value="0.197" />);
    expect(screen.getByText("0.197")).toBeInTheDocument();
  });

  it("renders a ReactNode value", () => {
    render(<StatCard label="Status" value={<span data-testid="custom-val">live</span>} />);
    expect(screen.getByTestId("custom-val")).toBeInTheDocument();
  });

  it("renders sub text when provided", () => {
    render(<StatCard label="Brier" value="0.197" sub="Target < 0.22" />);
    expect(screen.getByText("Target < 0.22")).toBeInTheDocument();
  });

  it("does not render sub element when sub is not provided", () => {
    render(<StatCard label="Brier" value="0.197" />);
    // Sub paragraph has text-slate-500 + text-xs + mt-1 classes
    const sub = document.querySelector(".text-slate-500.text-xs");
    expect(sub).toBeNull();
  });

  it("applies text-white to value by default", () => {
    const { container } = render(<StatCard label="Label" value="42" />);
    const valueEl = container.querySelector(".text-white");
    expect(valueEl).toBeInTheDocument();
    expect(valueEl).toHaveTextContent("42");
  });

  it("applies text-green-400 to value when accent=true", () => {
    const { container } = render(<StatCard label="Label" value="42" accent />);
    const valueEl = container.querySelector(".text-green-400");
    expect(valueEl).toBeInTheDocument();
    expect(valueEl).toHaveTextContent("42");
  });

  it("does not apply text-green-400 when accent is false", () => {
    const { container } = render(<StatCard label="Label" value="42" accent={false} />);
    expect(container.querySelector(".text-green-400")).toBeNull();
  });

  it("merges custom className onto outer card div", () => {
    const { container } = render(<StatCard label="L" value="V" className="my-stat" />);
    expect(container.firstChild).toHaveClass("my-stat");
  });

  it("passes through HTML attributes", () => {
    render(<StatCard label="L" value="V" data-testid="stat-card" />);
    expect(screen.getByTestId("stat-card")).toBeInTheDocument();
  });
});
