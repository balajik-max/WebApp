# Leadership Header and Public Registration Fix

## Leadership header

Order and mapping:

1. Shri. D.K. Shivakumar — Hon'ble Chief Minister
2. Shri Yathindra Siddaramaiah — Minister for Urban Development
3. Shri Gangadharaswamy G. M. — Deputy Commissioner, Davanagere

Only the shared public portal leadership block and its responsive styles were changed.

## Public registration

- Date of Birth was removed from the UI, TypeScript payload and backend request contract.
- The legacy database column remains for backward compatibility but is made nullable. Existing data is not deleted.
- Duplicate email/phone/username messages now direct an existing user to Public Login.
- Public Login now accepts either the registered username or registered email address.

## Safety

- Officer authentication and officer roles were not changed.
- Existing public users remain valid.
- Existing DOB values are preserved but no longer requested from new users.
