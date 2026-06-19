import { useCallback, useEffect } from 'react';
import { Booking } from '@/types/hotel';
import { differenceInCalendarDays, isBefore, parseISO, startOfDay } from 'date-fns';
import { toast } from 'sonner';
import { useI18n } from './useI18n';
import { useSharedState } from '@/lib/hotel-sync';

function bookingSignature(b: Booking): string {
  return [
    b.roomNumber,
    b.bedIndex ?? 'room',
    b.checkIn,
    b.checkOut,
    b.status,
    (b.guestName || '').trim().toLowerCase(),
  ].join('|');
}

function isLegacySampleBooking(b: Booking): boolean {
  return /^b\d+$/.test(String(b.id));
}

function normalizeBookings(input: unknown): Booking[] {
  if (!Array.isArray(input)) return [];
  const byId = new Map<string, Booking>();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const b = item as Booking;
    if (!b.id || !b.roomNumber || !b.checkIn || !b.checkOut || !b.status) continue;
    if (isLegacySampleBooking(b)) continue;
    byId.set(String(b.id), b);
  }
  const bySignature = new Map<string, Booking>();
  for (const b of byId.values()) bySignature.set(bookingSignature(b), b);
  return applyAutoCheckout(Array.from(bySignature.values()));
}

function bookingHalfSpan(b: Booking): [number, number] {
  const base = startOfDay(parseISO('2000-01-01'));
  const inDay = differenceInCalendarDays(parseISO(b.checkIn), base);
  const outDay = differenceInCalendarDays(parseISO(b.checkOut), base);
  return [
    2 * inDay + 1 - (b.checkInHalfDay ? 1 : 0),
    2 * outDay + 1 + (b.checkOutHalfDay ? 1 : 0),
  ];
}

function bookingsConflict(a: Booking, b: Booking): boolean {
  if (a.id === b.id) return false;
  if (a.roomNumber !== b.roomNumber) return false;
  const eitherIsRoomWide =
    a.status === 'maintenance' ||
    b.status === 'maintenance' ||
    a.bedIndex === undefined ||
    b.bedIndex === undefined;
  if (!eitherIsRoomWide) {
    const aBeds = new Set<number>([a.bedIndex as number, ...(a.additionalBeds ?? [])]);
    const bBeds = new Set<number>([b.bedIndex as number, ...(b.additionalBeds ?? [])]);
    let overlap = false;
    for (const bed of aBeds) {
      if (bBeds.has(bed)) {
        overlap = true;
        break;
      }
    }
    if (!overlap) return false;
  }
  const [aStart, aEnd] = bookingHalfSpan(a);
  const [bStart, bEnd] = bookingHalfSpan(b);
  return aStart < bEnd && bStart < aEnd;
}

function findConflict(list: Booking[], candidate: Booking): Booking | undefined {
  return list.find((b) => bookingsConflict(b, candidate));
}

function applyAutoCheckout(list: Booking[]): Booking[] {
  const today = startOfDay(new Date());
  let changed = false;
  const next = list.map((b) => {
    if (b.status === 'maintenance' || b.status === 'checked-out') return b;
    const out = parseISO(b.checkOut);
    if (isBefore(out, today)) {
      changed = true;
      return { ...b, status: 'checked-out' as const };
    }
    return b;
  });
  return changed ? next : list;
}

export function useBookings() {
  const { t } = useI18n();
  const { data: bookings, setData } = useSharedState<Booking[]>('bookings', []);

  // Auto-flip checked-out daily
  useEffect(() => {
    const tick = () =>
      setData((prev) => {
        const next = applyAutoCheckout(prev);
        return next === prev ? prev : next;
      });
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [setData]);

  const addBooking = useCallback(
    (booking: Booking) => {
      let rejected = false;
      setData((prev) => {
        const list = normalizeBookings(prev);
        const conflict = findConflict(list, booking);
        if (conflict) {
          rejected = true;
          toast.error(t('overlapError'));
          return prev;
        }
        return normalizeBookings([...list, booking]);
      });
      return !rejected;
    },
    [setData, t],
  );

  const removeBooking = useCallback(
    (id: string) => {
      setData((prev) => normalizeBookings(prev.filter((b) => b.id !== id)));
    },
    [setData],
  );


  const updateBooking = useCallback(
    (id: string, updates: Partial<Booking>) => {
      let rejected = false;
      setData((prev) => {
        const list = normalizeBookings(prev);
        const target = list.find((b) => b.id === id);
        if (!target) return prev;
        const candidate: Booking = { ...target, ...updates };
        const conflict = findConflict(list, candidate);
        if (conflict) {
          rejected = true;
          toast.error(t('overlapError'));
          return prev;
        }
        return normalizeBookings(list.map((b) => (b.id === id ? candidate : b)));
      });
      return !rejected;
    },
    [setData, t],
  );

  return { bookings, addBooking, removeBooking, updateBooking };
}
