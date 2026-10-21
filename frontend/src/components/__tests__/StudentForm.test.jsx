/**
 * @jest-environment jsdom
 */

/**
 * Regression test for issue #1576: StudentForm's save action called
 * api.patch while the backend only registered PUT for that resource, so
 * every edit from the UI 404'd. This asserts the form now issues a PATCH
 * to the encoded student path.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}));

// errorMessages.js pulls in the real i18n singleton, which registers the
// real react-i18next plugin — stub it out so it doesn't fight the mock above.
jest.mock('../../i18n', () => ({ t: (key) => key }));

jest.mock('../PaymentPlanForm', () => () => null);

jest.mock('axios', () => {
  const mockApi = jest.fn();
  mockApi.get = jest.fn();
  mockApi.post = jest.fn();
  mockApi.patch = jest.fn(() => Promise.resolve({ data: {} }));
  mockApi.delete = jest.fn();
  mockApi.interceptors = {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  };
  return { create: jest.fn(() => mockApi), __mockApi: mockApi };
});

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import StudentForm from '../StudentForm';

const mockApi = require('axios').__mockApi;

const STUDENT = {
  // IDs imported from CSV can contain '/' or spaces (see issue #1576) —
  // used here to also exercise the encodeURIComponent fix.
  studentId: 'STU 2024/01',
  name: 'Alice',
  class: '5A',
  parentEmail: '',
  parentPhone: '',
  reminderOptOut: false,
};

beforeEach(() => {
  mockApi.patch.mockClear();
});

test('saving the form issues a PATCH to the encoded student path', async () => {
  render(<StudentForm student={STUDENT} onClose={() => {}} onSave={() => {}} />);

  fireEvent.click(screen.getByText('studentForm.saveChanges'));

  await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));

  const [path, body] = mockApi.patch.mock.calls[0];
  expect(path).toBe(`/students/${encodeURIComponent(STUDENT.studentId)}`);
  expect(path).toBe('/students/STU%202024%2F01');
  expect(body).toEqual(
    expect.objectContaining({ name: 'Alice', class: '5A' }),
  );
});
