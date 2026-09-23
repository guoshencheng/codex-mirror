import type { DashboardSession } from '../contracts/dashboard';
import styles from './pixel-dashboard.module.css';

export default function PixelSessionIcon({ state, current }: { state: DashboardSession['state']; current: boolean }) {
  return <span className={styles.symbol} aria-hidden="true"><svg viewBox="0 0 16 16" shapeRendering="crispEdges">
    {!current ? <path d="M5 2h6v2H5zM11 4h2v3h-2zM8 7h3v2H8zM7 9h2v2H7zM7 12h2v2H7z" />
      : state === 'WORKING' ? <>
        <path d="M1 2h14v11H1z" /><path className={styles.pixelCutout} d="M3 4h10v7H3z" />
        <path d="M4 5h2v1H4zM6 6h2v1H6zM4 7h2v1H4z" />
        <path className={styles.pixelCursor} d="M9 9h3v1H9z" />
      </> : state === 'WAITING_APPROVAL' ? <>
        <path d="M2 1h12v2H2zM4 3h2v2H4zM10 3h2v2h-2zM6 5h4v2H6zM7 7h2v2H7zM6 9h4v2H6zM4 11h2v2H4zM10 11h2v2h-2zM2 13h12v2H2z" />
        <path className={styles.pixelSand} d="M7 10h2v2H7z" />
      </> : state === 'ENDED' ? <path d="M1 8h2v2H1zM3 10h2v2H3zM5 12h2v2H5zM7 10h2v2H7zM9 8h2v2H9zM11 6h2v2h-2zM13 4h2v2h-2z" />
        : state === 'INTERRUPTED' ? <path d="M2 2h2v2H2zM4 4h2v2H4zM6 6h4v4H6zM10 4h2v2h-2zM12 2h2v2h-2zM4 10h2v2H4zM2 12h2v2H2zM10 10h2v2h-2zM12 12h2v2h-2z" />
          : state === 'STOPPED' ? <path d="M2 2h12v12H2z" />
            : <path d="M2 7h2v2H2zM6 7h2v2H6zM10 7h2v2h-2z" />}
  </svg></span>;
}
