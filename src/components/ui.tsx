'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { addDays, type Area } from '@/lib/core';

export const AREAS: Area[] = ['A', 'B', 'C', 'D', 'omitted'];
export const money = (n: number) => new Intl.NumberFormat('ja-JP').format(n);
export const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
export const weekday = (date: string) => new Intl.DateTimeFormat('ja-JP', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
export const dateLabel = (date: string) => `${shortDate(date)}（${weekday(date)}）`;
export const typeLabel = (type: string) => type === 'refill' ? '補充' : type === 'pickup' ? '取出' : '棚卸';
export function newRecordId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function Sheet({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialog?.showModal();
    return () => { dialog?.close(); document.body.style.overflow = overflow; };
  }, []);
  return <dialog ref={ref} className={`sheet ${wide ? 'wide' : ''}`} aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="sheet-handle"/><header className="sheet-header"><h2 id={id}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="閉じる"><X size={22}/></button></header>
    <div className="sheet-body">{children}</div>
  </dialog>;
}
export function WeekPicker({ week, current, onChange }: { week: string; current: string; onChange: (date: string) => void }) {
  return <div className="week-picker"><button className="icon-button" aria-label="前の週" onClick={() => onChange(addDays(week, -7))}><ChevronLeft size={20}/></button><button className="week-label" onClick={() => onChange(current)} aria-label="今週に戻る">{shortDate(week)} — {shortDate(addDays(week, 6))}<span>{week === current ? '今週' : '今週に戻る'}</span></button><button className="icon-button" aria-label="次の週" disabled={week >= current} onClick={() => onChange(addDays(week, 7))}><ChevronRight size={20}/></button></div>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="empty-state">{children}</div>; }
