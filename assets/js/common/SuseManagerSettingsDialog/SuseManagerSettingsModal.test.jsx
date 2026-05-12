// SPDX-FileCopyrightText: SUSE LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { faker } from '@faker-js/faker';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { capitalize } from 'lodash';

import SuseManagerSettingsModal from '.';

describe('SuseManagerSettingsModal component', () => {
  it('renders correctly', async () => {
    await act(() =>
      render(
        <SuseManagerSettingsModal open onSave={() => {}} onChange={() => {}} />
      )
    );

    expect(screen.getByText('SUSE Manager URL')).toBeVisible();
    expect(screen.getByText('Username')).toBeVisible();
    expect(screen.getByText('Password')).toBeVisible();
    expect(screen.getAllByRole('textbox').length).toBe(3);

    expect(
      screen.getByPlaceholderText('Enter a SUSE Manager password')
    ).toBeVisible();
  });

  it('renders previous settings', async () => {
    const initialUrl = faker.internet.url();
    const initialUsername = faker.word.noun();
    const certUploadDate = faker.date.recent();

    await act(() =>
      render(
        <SuseManagerSettingsModal
          open
          initialUrl={initialUrl}
          initialUsername={initialUsername}
          certUploadDate={certUploadDate}
          onSave={() => {}}
          onCancel={() => {}}
        />
      )
    );

    expect(screen.getByText('Certificate Uploaded')).toBeVisible();
    expect(screen.getByText('•••••')).toBeVisible();
    expect(
      screen.queryByPlaceholderText('Enter a SUSE Manager password')
    ).not.toBeInTheDocument();
  });

  it('should try to save all the fields', async () => {
    const user = userEvent.setup();
    const url = faker.internet.url();
    const username = faker.word.noun();
    const password = faker.word.noun();
    const certificate = faker.lorem.text();
    const onSave = jest.fn();

    await act(() =>
      render(
        <SuseManagerSettingsModal open onSave={onSave} onCancel={() => {}} />
      )
    );

    const urlInput = screen.getByPlaceholderText('Enter a URL');
    const passwordInput = screen.getByPlaceholderText(
      'Enter a SUSE Manager password'
    );
    const userInput = screen.getByPlaceholderText(
      'Enter a SUSE Manager username'
    );
    const certificateInput = screen.getByPlaceholderText(
      'Starts with -----BEGIN CERTIFICATE-----'
    );

    // Use fireEvent.change to set the values atomically. userEvent.type
    // dispatches one keystroke per character with a re-render between each,
    // which makes this test exceed the 5s timeout when faker.lorem.text()
    // produces a long certificate string (it can return 500+ characters).
    fireEvent.change(urlInput, { target: { value: url } });
    fireEvent.change(passwordInput, { target: { value: password } });
    fireEvent.change(certificateInput, { target: { value: certificate } });
    fireEvent.change(userInput, { target: { value: username } });

    await user.click(screen.getByText('Save Settings'));

    expect(onSave).toHaveBeenCalledWith({
      username,
      url,
      password,
      ca_cert: certificate,
    });
  });

  it('should attempt saving only what changed', async () => {
    const user = userEvent.setup();
    const url = faker.internet.url();
    const username = faker.word.noun();
    const onSave = jest.fn();

    await act(() =>
      render(
        <SuseManagerSettingsModal
          initialUsername={faker.word.noun()}
          initialUrl={faker.internet.url()}
          certUploadDate={faker.date.recent()}
          open
          onSave={onSave}
          onCancel={() => {}}
        />
      )
    );

    const urlInput = screen.getByPlaceholderText('Enter a URL');
    const userInput = screen.getByPlaceholderText(
      'Enter a SUSE Manager username'
    );

    // Use fireEvent.change instead of user.clear() + user.type(): when
    // typing chars one at a time on a controlled input pre-populated with
    // initialUrl/initialUsername, the per-character re-renders raced with
    // the cursor position tracking inside userEvent, occasionally producing
    // an interleaved string ("hretwt..." instead of "https://..."). A
    // single change event replaces the value atomically.
    fireEvent.change(urlInput, { target: { value: url } });
    fireEvent.change(userInput, { target: { value: username } });

    await user.click(screen.getByText('Save Settings'));

    expect(onSave).toHaveBeenCalledWith({
      username,
      url,
    });
  });

  it('should display errors', async () => {
    const detail = capitalize(faker.lorem.words(5));

    const errors = [
      {
        detail,
        source: { pointer: '/url' },
        title: 'Invalid value',
      },
      {
        detail,
        source: { pointer: '/ca_cert' },
        title: 'Invalid value',
      },
    ];

    await act(() =>
      render(
        <SuseManagerSettingsModal
          initialUsername={faker.word.noun()}
          initialUrl={faker.internet.url()}
          errors={errors}
          open
          onSave={() => {}}
          onCancel={() => {}}
        />
      )
    );

    expect(screen.getAllByText(detail)).toHaveLength(2);
  });
});
