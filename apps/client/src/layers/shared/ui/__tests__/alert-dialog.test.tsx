/**
 * @vitest-environment jsdom
 *
 * The two exits of an alert dialog are the only way out of it, so on a phone
 * they must be real 44px thumb targets like every `Button`. They used to wear
 * `buttonVariants()` alone, the 36px desktop height, which the membership
 * accessibility proof measured at 390px (spec `community-membership-journeys`,
 * task 3.2).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '../alert-dialog';

afterEach(cleanup);

describe('AlertDialog exits are phone touch targets', () => {
  it('grows both exits to 44px below the md breakpoint and keeps 36px past it', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Disconnect?</AlertDialogTitle>
          <AlertDialogDescription>You stay a member.</AlertDialogDescription>
          <AlertDialogCancel>Keep connected</AlertDialogCancel>
          <AlertDialogAction>Disconnect</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    );
    for (const name of ['Keep connected', 'Disconnect']) {
      const exit = screen.getByRole('button', { name });
      expect(exit.className).toContain('h-11');
      expect(exit.className).toContain('md:h-9');
    }
  });
});
