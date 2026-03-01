import { render, screen } from "@testing-library/react";
import { ProgressBar, ProbabilityBar } from "./ProgressBar";

/** Get the fill bar (inner div inside the track div) */
function getFillBar(container: HTMLElement): HTMLElement {
  const track = container.querySelector(".overflow-hidden") as HTMLElement;
  return track.firstChild as HTMLElement;
}

describe("ProgressBar", () => {
  it("renders fill bar with correct width for 60%", () => {
    const { container } = render(<ProgressBar value={0.6} />);
    expect(getFillBar(container).style.width).toBe("60%");
  });

  it("clamps value above 1 to 100%", () => {
    const { container } = render(<ProgressBar value={1.5} />);
    expect(getFillBar(container).style.width).toBe("100%");
  });

  it("clamps value below 0 to 0%", () => {
    const { container } = render(<ProgressBar value={-0.3} />);
    expect(getFillBar(container).style.width).toBe("0%");
  });

  it("rounds fractional percentages", () => {
    const { container } = render(<ProgressBar value={0.333} />);
    expect(getFillBar(container).style.width).toBe("33%");
  });

  it("shows percentage text when showPct=true", () => {
    render(<ProgressBar value={0.75} showPct />);
    expect(screen.getByText("75%")).toBeInTheDocument();
  });

  it("does not show percentage text by default", () => {
    const { container } = render(<ProgressBar value={0.75} />);
    // No text node with percentage (only the fill bar exists, no span)
    expect(container.querySelector(".font-mono")).toBeNull();
  });

  it("renders label when provided", () => {
    render(<ProgressBar value={0.5} label="xG" />);
    expect(screen.getByText("xG")).toBeInTheDocument();
  });

  it("does not render label element when not provided", () => {
    const { container } = render(<ProgressBar value={0.5} />);
    expect(container.querySelector("span.text-slate-400")).toBeNull();
  });

  it("uses green as default fill color", () => {
    const { container } = render(<ProgressBar value={0.5} />);
    // #22c55e → rgb(34, 197, 94)
    expect(getFillBar(container).style.background).toBe("rgb(34, 197, 94)");
  });

  it("applies custom color", () => {
    const { container } = render(<ProgressBar value={0.5} color="#38bdf8" />);
    // #38bdf8 → rgb(56, 189, 248)
    expect(getFillBar(container).style.background).toBe("rgb(56, 189, 248)");
  });

  it("applies custom className to wrapper", () => {
    const { container } = render(<ProgressBar value={0.5} className="my-bar" />);
    expect(container.firstChild).toHaveClass("my-bar");
  });
});

describe("ProbabilityBar", () => {
  it("displays home percentage", () => {
    render(<ProbabilityBar home={0.5} draw={0.25} away={0.25} />);
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("displays away percentage", () => {
    render(<ProbabilityBar home={0.5} draw={0.2} away={0.3} />);
    expect(screen.getByText("30%")).toBeInTheDocument();
  });

  it("sets correct width on home segment via title attribute", () => {
    const { container } = render(<ProbabilityBar home={0.6} draw={0.2} away={0.2} />);
    const homeSegment = container.querySelector("[title='Home 60%']") as HTMLElement;
    expect(homeSegment).toBeInTheDocument();
    expect(homeSegment.style.width).toBe("60%");
  });

  it("sets correct width on draw segment via title attribute", () => {
    const { container } = render(<ProbabilityBar home={0.6} draw={0.2} away={0.2} />);
    const drawSegment = container.querySelector("[title='Draw 20%']") as HTMLElement;
    expect(drawSegment).toBeInTheDocument();
    expect(drawSegment.style.width).toBe("20%");
  });

  it("sets correct width on away segment via title attribute", () => {
    const { container } = render(<ProbabilityBar home={0.6} draw={0.2} away={0.2} />);
    const awaySegment = container.querySelector("[title='Away 20%']") as HTMLElement;
    expect(awaySegment).toBeInTheDocument();
    expect(awaySegment.style.width).toBe("20%");
  });
});
