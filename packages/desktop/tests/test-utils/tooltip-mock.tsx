import React from 'react';

type TooltipContextValue = {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

type TriggerChildProps = {
  onPointerEnter?: (event: React.PointerEvent) => void;
  onPointerLeave?: (event: React.PointerEvent) => void;
  onFocus?: (event: React.FocusEvent) => void;
  onBlur?: (event: React.FocusEvent) => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
};

export function createTooltipMock() {
  const TooltipContext = React.createContext<TooltipContextValue | null>(null);

  return {
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Tooltip: ({ children }: { children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      return (
        <TooltipContext.Provider value={{ open, setOpen }}>{children}</TooltipContext.Provider>
      );
    },
    TooltipTrigger: ({
      children,
      asChild,
    }: {
      children: React.ReactElement<TriggerChildProps>;
      asChild?: boolean;
    }) => {
      const context = React.useContext(TooltipContext);
      if (!context) {
        return children;
      }

      const child = React.Children.only(children);
      const triggerProps: TriggerChildProps = {
        onPointerEnter: (event) => {
          child.props.onPointerEnter?.(event);
          context.setOpen(true);
        },
        onPointerLeave: (event) => {
          child.props.onPointerLeave?.(event);
          context.setOpen(false);
        },
        onFocus: (event) => {
          child.props.onFocus?.(event);
          context.setOpen(true);
        },
        onBlur: (event) => {
          child.props.onBlur?.(event);
          context.setOpen(false);
        },
        onKeyDown: (event) => {
          child.props.onKeyDown?.(event);
          if (event.key === 'Escape') {
            context.setOpen(false);
          }
        },
      };

      if (asChild) {
        return React.cloneElement(child, triggerProps);
      }

      return <button type="button" {...triggerProps} />;
    },
    TooltipContent: ({
      children,
      ...props
    }: React.ComponentProps<'div'> & { children: React.ReactNode }) => {
      const context = React.useContext(TooltipContext);
      if (!context?.open) {
        return null;
      }

      return <div {...props}>{children}</div>;
    },
  };
}
