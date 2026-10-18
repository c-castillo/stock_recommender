import type { Metadata } from "next";
import TradeJournal from "./TradeJournal";

export const metadata: Metadata = { title: "Bitácora de trades" };

export default function BitacoraPage() {
  return <TradeJournal />;
}
