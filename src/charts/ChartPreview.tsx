import { useEffect, useRef } from "react";
import { ChartCanvas } from "@/charts/chart-canvas";
import type { ChartData, ChartLook } from "@/charts/data";

interface ChartPreviewProps {
  readonly look: ChartLook;
  readonly data: ChartData | null;
  readonly width: number;
  readonly height: number;
  readonly compact?: boolean;
  readonly className?: string;
}

/** A chart drawn on a canvas, for dialogs (live preview, type gallery). */
export function ChartPreview({ look, data, width, height, compact = false, className }: ChartPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<ChartCanvas | null>(null);

  useEffect(() => {
    const view = new ChartCanvas({ compact, border: !compact });
    viewRef.current = view;
    hostRef.current?.appendChild(view.canvas);
    return () => {
      view.dispose();
      view.canvas.remove();
      viewRef.current = null;
    };
  }, [compact]);

  useEffect(() => {
    viewRef.current?.setSize(width, height, 1);
  }, [width, height, compact]);

  useEffect(() => {
    viewRef.current?.setContent(look, data);
  }, [look, data, compact]);

  return <div ref={hostRef} className={className} style={{ width, height }} aria-hidden="true" />;
}
