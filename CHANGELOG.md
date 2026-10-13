# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it.

## [Unreleased]

### Changed

- Quieter logs: the regular readings, the routine re-login to ecojoko and the
  repeated failures are now written at debug level. A failure is reported once
  when it starts and once when it is over, instead of on every attempt.
- Integration SDK 0.15.

### Fixed

- If Gladys polling is turned on for a device, a poll no longer reads ecojoko a
  second time right after a scheduled reading.
