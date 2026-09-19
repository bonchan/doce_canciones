import React from 'react';
import { useSearchParams } from 'react-router-dom';
import DeviceListPage from './DeviceListPage';
import DeviceDetailPage from './DeviceDetailPage';

// Single entry point mounted at /devices — query-param driven instead of
// /devices/:deviceId, so a link is a plain shareable URL and the browser
// back/forward buttons work across list <-> detail the same way they would
// for any other query-string-based filter:
//   /devices              -> full list (zone-filterable in DeviceListPage)
//   /devices?type=voice   -> list filtered down to just that device type
//   /devices?id=abcd1234  -> that one device's detail/config page
// `id` wins if both are present — matches "id=DEVICEID works as it was
// working", i.e. the original single-device view is unconditional on id.
export default function DevicesPage(props) {
  const [searchParams] = useSearchParams();
  const id = searchParams.get('id');
  const type = searchParams.get('type');

  if (id) {
    return <DeviceDetailPage {...props} deviceId={id} />;
  }
  return <DeviceListPage {...props} typeFilter={type} />;
}
