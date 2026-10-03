import { Component, type ReactNode } from 'react'
import { reloadDisplay, reportError } from '../errors.ts'

// A view that crashes reports it and reloads the display instead of staying blank; if reloads
// aren't helping (see reloadDisplay), it tries drawing the view again every 30 s.
export class Recover extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    reportError('crash', error)
    if (!reloadDisplay('the view crashed')) setTimeout(() => this.setState({ failed: false }), 30_000)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
