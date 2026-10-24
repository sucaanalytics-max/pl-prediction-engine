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
          Pages open offline and show the data last fetched on this device, with
          a banner giving its age. Nothing is live until the connection returns,
          and data this device has never fetched cannot load. You are seeing this
          page because the one you asked for is not stored here.
        </p>
        <Link href="/" className="primary-action">
          <ArrowLeft size={15} /> Return to overview
        </Link>
      </section>
    </div>
  );
}
