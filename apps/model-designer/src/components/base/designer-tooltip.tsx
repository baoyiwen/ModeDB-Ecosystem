import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type TooltipPosition = {
  top: number;
  left: number;
};

export type DesignerTooltipTriggerProps = {
  'aria-describedby'?: string;
  onBlur: (event: FocusEvent<Element>) => void;
  onFocus: (event: FocusEvent<Element>) => void;
  onPointerEnter: (event: PointerEvent<Element>) => void;
  onPointerLeave: () => void;
  onPointerMove: (event: PointerEvent<Element>) => void;
};

export function DesignerTooltip(props: {
  content: ReactNode;
  children: (triggerProps: DesignerTooltipTriggerProps) => ReactNode;
  disabled?: boolean;
}): ReactElement {
  const tooltipId = useId();
  const closeTimerRef = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({ top: 0, left: 0 });

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== undefined) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const updatePosition = (clientX: number, clientY: number): void => {
    const margin = 12;
    const offset = 14;
    const estimatedWidth = 260;
    setPosition({
      top: Math.min(clientY + offset, window.innerHeight - margin),
      left: Math.min(
        Math.max(clientX + offset, margin),
        window.innerWidth - estimatedWidth - margin,
      ),
    });
  };

  const openTooltip = (clientX: number, clientY: number): void => {
    if (props.disabled) {
      return;
    }
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
    updatePosition(clientX, clientY);
    setOpen(true);
  };

  const closeTooltip = (): void => {
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = undefined;
    }, 70);
  };

  const triggerProps: DesignerTooltipTriggerProps = {
    'aria-describedby': open ? tooltipId : undefined,
    onBlur: closeTooltip,
    onFocus: (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      openTooltip(rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    onPointerEnter: (event) => openTooltip(event.clientX, event.clientY),
    onPointerLeave: closeTooltip,
    onPointerMove: (event) => {
      if (open) {
        updatePosition(event.clientX, event.clientY);
      }
    },
  };

  const overlay =
    open && !props.disabled && typeof document !== 'undefined'
      ? createPortal(
          <div
            id={tooltipId}
            className="designer-tooltip"
            role="tooltip"
            style={{
              top: position.top,
              left: position.left,
            }}
          >
            {props.content}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {props.children(triggerProps)}
      {overlay}
    </>
  );
}
