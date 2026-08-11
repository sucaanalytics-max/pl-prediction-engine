import Link from "next/link";
import { ArrowLeft, CloudOff, ShieldCheck } from "lucide-react";

export default function OfflinePage() {
  return (
    <div className="portal-page offline-page animate-slide-up">
      <section className="decision-card">
        <span className="offline-icon"><CloudOff size={28} /></span>
        <div className="eyebrow"><ShieldCheck size={13} /> Offline-safe shell</div>
        <h1>You are offline</h1>
        <p>
          Previously opened portal pages remain available, but live FPL prices,
          fixtures and squad recommendations need a connection to refresh.
        </p>
        <Link href="/" className="primary-action">
          <ArrowLeft size={15} /> Return to overview
        </Link>
      </section>
    </div>
  );
}
