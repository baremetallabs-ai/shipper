import { Search } from 'lucide-react';
import { Command as CommandPrimitive } from 'cmdk';
import type { ComponentProps, ComponentRef, JSX } from 'react';
import { forwardRef } from 'react';

import { cn } from '../../lib/utils.js';

export const Command = forwardRef<
  ComponentRef<typeof CommandPrimitive>,
  ComponentProps<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    data-slot="command"
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-sm bg-transparent text-foreground',
      className
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>): JSX.Element {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex items-center border-b border-border px-3"
    >
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-10 w-full rounded-sm bg-transparent py-3 pl-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
    </div>
  );
}

export const CommandList = forwardRef<
  ComponentRef<typeof CommandPrimitive.List>,
  ComponentProps<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    data-slot="command-list"
    className={cn('max-h-[300px] overflow-x-hidden overflow-y-auto', className)}
    {...props}
  />
));
CommandList.displayName = CommandPrimitive.List.displayName;

export function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Empty>): JSX.Element {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn('py-6 text-center text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export const CommandGroup = forwardRef<
  ComponentRef<typeof CommandPrimitive.Group>,
  ComponentProps<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    data-slot="command-group"
    className={cn(
      'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.16em] [&_[cmdk-group-heading]]:text-muted-foreground',
      className
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitive.Group.displayName;

export const CommandSeparator = forwardRef<
  ComponentRef<typeof CommandPrimitive.Separator>,
  ComponentProps<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    data-slot="command-separator"
    className={cn('-mx-1 h-px bg-border', className)}
    {...props}
  />
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

export const CommandItem = forwardRef<
  ComponentRef<typeof CommandPrimitive.Item>,
  ComponentProps<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    data-slot="command-item"
    className={cn(
      'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
      className
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitive.Item.displayName;
