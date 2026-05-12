// SPDX-FileCopyrightText: SUSE LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { render, screen } from '@testing-library/react';

import { APPLICATION_TYPE, DATABASE_TYPE } from '@lib/model/sapSystems';

import DeregistrationModal from '.';

describe('Deregistration Modal component', () => {
  it('should render a host deregistration modal correctly', async () => {
    // Use a deterministic hostname that cannot appear as a substring in the
    // modal body, button labels, or any other rendered text. Random faker
    // names like "Will", "Trent", "Al" or "Ed" used to collide with words in
    // the body ("will", "Trento", "all", "discovered"), causing
    // `findByText(hostname, { exact: false })` to match multiple nodes.
    const hostname = 'host-xyz-1234567890';

    render(
      <DeregistrationModal
        hostname={hostname}
        isOpen
        onCleanUp={() => {}}
        onCancel={() => {}}
      />
    );

    expect(await screen.findByText(hostname, { exact: false })).toBeTruthy();
    expect(
      await screen.findByText(
        'This action will cause Trento to stop tracking',
        { exact: false }
      )
    ).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: /Clean up/i })
    ).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Cancel/i })).toBeTruthy();
  });

  it('should render an application instance deregistration modal correctly', async () => {
    // Use deterministic identifiers that cannot collide with any substring of
    // the rendered body text. A randomly generated 3-char alphanumeric sid
    // (e.g. "ASC", "SCS", "TIO") would occasionally appear inside the body
    // string ("ASCS instance", "Application", "deregistration"), making
    // `findByText(sid, { exact: false })` match multiple nodes intermittently.
    const sid = '999';
    const instanceNumber = '88';

    render(
      <DeregistrationModal
        contentType={APPLICATION_TYPE}
        sid={sid}
        instanceNumber={instanceNumber}
        isOpen
        onCleanUp={() => {}}
        onCancel={() => {}}
      />
    );

    expect(await screen.findByText(sid, { exact: false })).toBeTruthy();
    expect(
      await screen.findByText(instanceNumber, { exact: false })
    ).toBeTruthy();
    expect(
      await screen.findByText('In the case of an ASCS instance', {
        exact: false,
      })
    ).toBeTruthy();
  });

  it('should render a database instance deregistration modal correctly', async () => {
    // See note in the application-instance test above; the same flakiness
    // applied here when the random sid happened to be a substring of the
    // modal body (e.g. "ATA" in "database", "PRI" in "Primary").
    const sid = '777';
    const instanceNumber = '88';

    render(
      <DeregistrationModal
        contentType={DATABASE_TYPE}
        sid={sid}
        instanceNumber={instanceNumber}
        isOpen
        onCleanUp={() => {}}
        onCancel={() => {}}
      />
    );

    expect(await screen.findByText(sid, { exact: false })).toBeTruthy();
    expect(
      await screen.findByText(instanceNumber, { exact: false })
    ).toBeTruthy();
    expect(
      await screen.findByText('In the case of the last database instance', {
        exact: false,
      })
    ).toBeTruthy();
  });
});
