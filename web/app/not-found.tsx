import Link from "next/link";
import { StateNotice, buttonClass, px } from "../components/pixel/Pixel";

export default function NotFound() {
  return (
    <main style={{ padding: 16 }}>
      <div className={px.board}>
        <StateNotice
          message="This room isn't built."
          detail="No screen exists at this address."
          action={
            <Link href="/" className={buttonClass()}>
              Back to the keep
            </Link>
          }
        />
      </div>
    </main>
  );
}
