import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V12H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-j" d="M8 0H16V16H12V4H8V0ZM0 12H4V16H12V20H4V20H0V12Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V60H60V80Z" fill="var(--icon-base)" />
      <path d="M40 0H80V80H60V20H40V0ZM0 60H20V80H60V100H20H0V60Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 264 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        {/* j */}
        <path d="M18 30H12V18H18V30Z" fill="var(--icon-weak-base)" />
        <path d="M12 6H24V36H18V12H12V6ZM0 24H6V30H18V36H6V42H0V24Z" fill="var(--icon-base)" />
        {/* u */}
        <path d="M48 30H36V18H48V30Z" fill="var(--icon-weak-base)" />
        <path d="M48 6H36V30H48V6ZM54 36H30V6H54V36Z" fill="var(--icon-base)" />
        {/* n */}
        <path d="M78 36H66V18H78V36Z" fill="var(--icon-weak-base)" />
        <path d="M78 12H66V36H60V6H78V12ZM84 36H78V12H84V36Z" fill="var(--icon-base)" />
        {/* t */}
        <path d="M108 30H102V18H108V30Z" fill="var(--icon-weak-base)" />
        <path d="M96 0H102V36H96V0ZM90 6H96V12H90V6ZM102 6H108V36H102V6ZM108 18H102V30H108V18Z" fill="var(--icon-base)" />
        {/* o */}
        <path d="M138 30H126V18H138V30Z" fill="var(--icon-weak-base)" />
        <path d="M138 12H126V30H138V12ZM144 36H120V6H144V36Z" fill="var(--icon-base)" />
        {/* c */}
        <path d="M174 30H156V18H174V30Z" fill="var(--icon-weak-base)" />
        <path d="M174 12H156V30H174V36H150V6H174V12Z" fill="var(--icon-strong-base)" />
        {/* o */}
        <path d="M198 30H186V18H198V30Z" fill="var(--icon-weak-base)" />
        <path d="M198 12H186V30H198V12ZM204 36H180V6H204V36Z" fill="var(--icon-strong-base)" />
        {/* d */}
        <path d="M228 30H216V18H228V30Z" fill="var(--icon-weak-base)" />
        <path d="M228 12H216V30H228V12ZM234 36H210V6H228V0H234V36Z" fill="var(--icon-strong-base)" />
        {/* e */}
        <path d="M264 24V30H246V24H264Z" fill="var(--icon-weak-base)" />
        <path d="M264 24H246V30H264V36H240V6H264V24ZM246 18H258V12H246V18Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
