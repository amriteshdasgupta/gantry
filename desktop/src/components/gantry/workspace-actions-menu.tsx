"use client";
import { useRef } from "react";
import { EllipsisVerticalIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";

/** The actions for one workspace in the sidebar. */
export function WorkspaceActionsMenu({ name, onSettings, onRemove }: { name: string; onSettings: () => void; onRemove: () => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <Menu modal={false}>
    <MenuTrigger ref={trigger} render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`} />}><EllipsisVerticalIcon /></MenuTrigger>
    <MenuContent>
      {/* The dialog returns focus to whatever was focused when it opened, so that must be the trigger and not this item, which is about to unmount. */}
      <MenuItem onClick={() => { trigger.current?.focus(); onSettings(); }}><SettingsIcon />Settings</MenuItem>
      <MenuItem onClick={() => { trigger.current?.focus(); onRemove(); }}><Trash2Icon />Remove workspace</MenuItem>
    </MenuContent>
  </Menu>;
}
